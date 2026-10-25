# Google Tasksの双方向取り消しと処理監査（2026-10-25）

## 対象と判断

基準は `2644396e0286792c732a592863adf7190fdf2efb` のmainです。提供された監査文を現行コードと照合しました。旧仕様ではGoogle側の完了取り消しを取り込まないことが意図されていましたが、今回のユーザー指定を優先し、完了・取り消しの両方を双方向に変更しました。

Scheduler本体のアルゴリズムを変える根拠は得られなかったため、呼び出しの重複と状態遷移を中心に変更しています。

## 採用した修正

### 1. 完了・取り消しを双方向にする

- アプリで取り消すと、対応する同じGoogle Taskへ `status: needsAction, completed: null` を送ります。
- Googleで取り消すと、対応する既存の履歴を未完了へ変更します。既存の取り消し処理を共有し、周期の起点と次回予定を再計算します。
- Googleで再び完了しても、既存の履歴行を更新し、履歴やGoogle Taskを増やしません。
- 同期済み状態と未送信のローカル状態・操作revisionをSQLiteに保存します。通信失敗後も未送信操作は残ります。
- 古い送信の完了確認で、同期中に発生した新しい操作を消さないよう、revisionを条件に未送信操作を消去します。
- Googleからの取り込み時も、同一トランザクション内で最新のローカル操作を確認します。未送信のローカル操作を古いGoogle情報で上書きしません。
- ホーム・カレンダーの取り消し後にも即時同期を要求します。
- Taskそのものの削除は取り消しと区別し、ローカル履歴を削除しません。

旧版には同期済み状態がないため、最初の同期では基準を確立します。この時点で未送信の可能性があるローカル完了は保持・送信します。ローカルとGoogleが未同期のまま同時に変更された場合、未送信のローカル操作を優先します。任意の端末間で厳密な「最後の操作時刻勝ち」を保証する方式ではありません。

変更: `contracts.ts`、`reconcile-google-tasks.ts`、`coordinator.ts`、Google Tasks API adapter、`repository.ts`、ホーム・カレンダー・設定画面、Google連携設定ドキュメント。

### 2. Plannerの共有Snapshotと更新経路

- SQLiteProvider直下に `PlannerDataProvider` を1個置き、画面は共有Snapshotを購読します。
- 画面ごとのfocus購読・AppState購読・日付タイマーを廃止し、Providerでまとめて管理します。
- 連続した更新要求をキューでまとめます。途中に変更が入った場合は古い結果を公開せず、最新の結果を読み直します。
- Widget操作のIDをまとめ、処理後にWidget・通知を公開する責任をProviderへ集約しました。
- Googleからの取り込みを画面側で処理する場合は、別経路のWidget・通知更新を重ねません。画面のないバックグラウンド実行では従来の更新経路を残します。
- `readCachedPlannerSnapshot` はDBへ書かない純粋なキャッシュ読み取りです。DB変更、日付・timezone変更、Calendarキャッシュ期限切れ、時刻巻き戻りで無効になります。
- 復帰時・Widget操作時は、別接続からの変更を考慮してキャッシュを使わず読み直します。同じSnapshotを再取得しただけなら副作用を再公開しません。
- 内容が変わらない天気結果で、Snapshotの世代を不要に進めないようにしました。
- 家電の確認用コンテキストの読込を、予定を変更する操作として扱わないよう修正しました。
- 家電解析結果を保存した後にも共有refreshを呼び、ホーム・カレンダー・家電一覧へ登録結果を反映します。
- 出力更新の失敗で画面を失敗扱いにせず、同じキャッシュを次回読み直した場合も再試行できるようにしました。

全面的にRepository APIを作り直す案は採らず、現在の明示的な再生成APIを残したまま、通常の画面表示ではキャッシュ・共有Snapshotを使う形にしました。

変更: `src/features/planner/refresh-controller.ts`、`use-planner-data.ts`、root layout、Widget完了同期・更新adapter、Google変更イベント、Google取り込み後の出力更新、`repository.ts`。

### 3. Calendarの不要な再計算を省く

CalendarがSchedulerへ最後に反映した署名を保存します。署名には候補日の評価に影響する日付・busy区分だけを含め、取得時刻や同じ区分内の分数変更は含めません。

- 新鮮なキャッシュで更新不要の場合は再計算しません。
- 再取得してもbusy区分が同じなら再計算しません。
- キャッシュ期限切れなどで利用する条件が変わった場合は再計算し、古いCalendarの影響を除きます。
- 再計算後のSnapshotをそのまま使い、再度DBから予定一覧を取得したり、出力更新のためにもう一度再計算したりする往復を減らしました。

変更: `calendar-availability.ts`、`calendar-coordinator.ts`、`repository.ts`。

### 4. SQLite移行の原子性

- スキーマversionを16に更新し、Google同期状態3列とCalendar署名1列を追加しました。
- 未適用の移行全体を1トランザクションへまとめ、DDLと `user_version` を同時に確定します。バージョンごとの多数のトランザクションへ分解する案より、今回の小さなローカルDBでは単純で、途中の状態を残しません。
- WAL・foreign_keys・busy_timeoutはトランザクション外で設定します。
- 旧版で列だけが追加済みのDBにも対応するよう、列の有無を確認します。
- 同じ接続での同時移行をまとめ、移行中のSQLite busy/lockedには最大2回の再試行を行います。任意のユーザー操作を自動再実行する処理にはしていません。

変更: `migrations.ts`。

### 5. 家電AIの通信・重複処理

- 固定600msの状態確認を、1秒・1.5秒・2秒・3秒のbackoffへ変更しました。サーバーの待機指示も使いますが、待機時間は最大5秒に制限します。
- 待機中にタイムアウトした場合も、待機終了を待たずに終了できます。
- 同一入力の進行中解析を共有し、成功した公式資料の解析結果だけを1時間・最大100件キャッシュします。利用するキーにはメーカー・製品名・型番・カテゴリと解析方式のversionを含めます。公式説明書URL・出典・解析日時は結果内に保持します。
- 入力段階の短期キャッシュにより、製品同定・説明書探索も含めた重複通信を省きます。毎回説明書URLを再探索してからキーを作る案より、今回の目的に合っています。
- 既存家電の「公式資料を再解析」はキャッシュを使いません。
- 重複したjob要求は同じjob IDを返し、処理中のjobを件数整理だけで消しません。
- エラーや未特定の結果はキャッシュしません。カテゴリ・型番の異なる入力を混同せず、共有結果はコピーして返します。
- 同時解析は標準3件、解析開始はサーバープロセス全体で1時間20件に制限します。既存のIP単位制限も維持し、IP管理Mapの件数を制限しました。
- 制限値は `APPLIANCE_CARE_MAX_CONCURRENT` / `APPLIANCE_CARE_MAX_PER_HOUR` で変更できます。
- Web版のAI送信停止、モデル、プロンプト、公式出典の検証は維持しています。

このキャッシュと制限は単一プロセス内のものです。認証の代替ではなく、再起動・複数インスタンスをまたぐ恒久的な課金上限でもありません。

変更: client・API契約・polling helper、家電の再解析画面、HTTP server・service・analysis runner、`.env.server.example`。

### 6. Native依存とCI

- 直接パッチする `expo-widgets` と `react-native-nitro-google-signin` を、lockfileで検証した現在のバージョンへ固定しました。
- 既存のfail-fastなpostinstallパッチ・その検証を保持しました。
- Native configuration workflowを追加し、関連変更時にクリーンインストール・Expo Doctor・Android Prebuildを実行します。
- 同じworkflowの手動実行で `compileAndroid` を選ぶと、Android debugのコンパイルも実行します。通常の設定生成チェックをコンパイル成功とは扱いません。
- 設定画面の同期説明は、OS任せのバックグラウンド実行を正確な1時間周期として保証しない表現へ変更しました。

変更: `package.json`、`package-lock.json`、`.github/workflows/native-check.yml`、設定画面。

### 7. README・仕様説明

- READMEは今回提供された文面へそのまま差し替えました。画像用コメントを実行指示として扱わず、コメントのまま保持しています。
- READMEのSHA-256: `89b0955e8cdaa3382ab083623b72debeb0fe582d28a3748b4c38eda865f54a74`
- 現行のGoogle連携セットアップ説明を更新し、旧Phase 2の検証記録には旧仕様である旨だけを追記しました。過去の実アカウント検証を、今回の新仕様の実アカウント検証に読み替えていません。

## 今回採用しなかった提案

| 提案 | 判断理由 |
| --- | --- |
| Schedulerの差分再計算・細かい計算最適化 | 20家事程度でアルゴリズム変更が必要な実測根拠がないため、呼び出し回数の削減を優先。 |
| Repositoryを多数のファイルへ全面分割 | ファイルサイズ自体は不具合ではなく、同時に変更すると移行・取り消しのレビュー範囲を広げるため。新しい調整処理は独立モジュールへ分離。 |
| Planner履歴を期間で単純に切る・履歴画面をpagination化 | 取り消し・未来完了・以前の状態の復元が履歴へ依存しているため、根拠なく取得範囲を狭めない。 |
| Redis等の永続job store | 現状の単一インスタンス構成に新しい運用依存を追加する必要がないため。再起動でjobが失われる制約は残る。 |
| DB・世帯ごとのGoogle Coordinatorへ全面移行 | 現状1世帯・1主DBで別世帯が巻き込まれた根拠がなく、今回の中心である状態遷移の修正と分けるため。物理DBをまたぐ完全な相互排他を実装したとは主張しない。 |
| クライアントへ固定秘密キーを埋め込む認証 | 秘密にならず、適切な課金防御にならない。常設公開では別途サーバー認証・永続quotaが必要。 |
| パッチ対象ライブラリのfork・新しい同期基盤 | 既存の検証済み挙動を維持し、固定バージョンとCIで検出可能性を上げる方を優先。 |

## 確認結果

| 確認 | 結果 |
| --- | --- |
| `npm run check` | PASS（lint・型チェック・226/226テスト） |
| Expo Doctor | PASS（20/20） |
| Android Prebuild（no-install） | PASS |
| Web静的export | PASS |
| postinstallパッチ適用 | PASS |
| `git diff --check` | PASS |
| 提供READMEとのバイト一致 | PASS |

追加した主な検証は、双方向の完了・取り消し・再完了、失敗後の再送、送信中の操作競合、共有refreshのまとめ処理、古い天気結果の排除、Calendar再計算の省略、移行途中の失敗・再試行、解析結果の共有・期限切れ・強制再解析・上限です。

今回の検証は隔離SQLite・模擬API・ソースとNative設定生成で行いました。新仕様の実GoogleアカウントE2E、実機バックグラウンド、iOS/Androidのコンパイルは今回は行っていません。有料の実OpenAI APIも呼んでいません。

参照: [Google Tasks Task resource](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks)、[Google Tasks patch](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/patch)、[Expo SDK 58 SQLite](https://docs.expo.dev/versions/v58.0.0/sdk/sqlite/)、[Expo CNG](https://docs.expo.dev/workflow/continuous-native-generation/)。
