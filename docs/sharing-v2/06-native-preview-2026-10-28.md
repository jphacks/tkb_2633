# v2 Native画面の隔離検査

検査日：2026-10-27夜〜28日。基点`2ce4c734b3dbbb82ba4ca1b742446c5eb5a5a758`へのPhase 4d差分、未公開共通ルール`liflow-shared-2-draft-10`。通常の共有グループへ接続する前に、実際のNative表示とSQLite操作を確認した。

## 使用した経路

開発ビルドの`houseworkplanner://development/sharing-v2-preview`は、明示した合成ユーザー・グループ、メモリ上の検査用鍵、独立したSQLiteを使用する。実際の署名、受信業務検証、操作履歴、Outbox、Planner、自動保存、共通UI部品を通す。クラウド送信、Firebaseログイン、本人Calendarの取得、グループ選択は行わない。サーバーreceiptを捏造しない。検査用Outboxは未送信のまま保持する。

releaseではファクトリと画面の両方で開始を拒否し、DBを開かないことを自動検査する。開発中のFast Refresh・画面移動では、同じ検査セッションを再利用する。内部モデルや未公開計算ルールの版が変わったときだけ、新しい独立した検査セッションを使い、元のDBを削除しない。

| 環境 | 方法 | 結果 |
| --- | --- | --- |
| iPhone 12 / iOS 26.7.2 | インストール済みdevelopment build、XCTest、実SQLite | 引き受け、完了、対象指定の取消、周期を17へ変更、すぐ戻る、再び開いて17を確認 |
| Sony I4293 / Android 10（API29） | インストール済みdevelopment build、ADB、実SQLite | 同じ操作とAndroidの戻るキー。再表示の値17を確認 |
| Housework QA / iOS27 Simulator | 既存の古いNative build | ExpoCryptoを持たず起動失敗。成功とは扱わず、データを初期化せず物理端末で検査を続行 |

Androidのfont scaleは既存設定1.15、density420を維持した。両端末の数値・単位の配置をスクリーンショットで目視確認した。

## 検査で見つけた問題

- 日付変更後に基準日だけでホーム抽出していた検査画面を、本人向け推奨日の表示へ接続。共通基準日や共有イベントを動かして解決しない。
- 完了を取り消した後に周期を変えると、旧版の取消済み記録が現在の枠を置き換えた。取消済みの履歴を残しつつ現在の枠を操作可能にし、後の有効な実作業がある場合も元の文脈を維持する。
- iPhoneの初回テストでは、数値を消す操作が先頭カーソルに対して行われ、入力が177になった。アプリが17を177へ変えたものではない。テストを数値全体の選択・置換へ直し、入力直後と再表示時の両方で17を検査した。

最初の失敗をPASSへ読み替えず、問題を修正した後の検査を以下に分けて保持する。

## ローカル証拠

一時ディレクトリ`/tmp/liflow-v2-20261027/`に保存。資格情報・鍵をドキュメントや成果物へ含めない。

- `phase4d-iphone-native-pass.xcresult` / `.log`：XCTest 1件成功、引き受けから保存値の再確認までの操作。
- `iphone-native-pass/`：XCTestから取り出した画面とアクセシビリティツリー。
- `phase4d-android-controls-fixed.log`：ADBの各段階の成功。合計77.63秒にはUI階層取得、スクリーンショット、文字入力、初期画面待ちを含み、単独APIの処理時間ではない。
- `android-v2-autosave-17.png` / `.xml`：Androidの保存後の画面。
- `phase4d-undo-cadence-repro.log`：修正前の取消・周期変更の反例。
- `phase4d-undo-cadence-fixed.log`：関連65件成功。
- `phase4d-ios-confirmed.log` / `phase4d-android-confirmed.log`：各1119件、lint・型検査成功。
- `phase4d-cloud.log`：Firestore Emulator結合25件成功。

保存値17のスクリーンショットSHA-256：

- iPhone：`03edbabda3a81bced2e167f77671682db2bdebe91236fb0a6383841f3dcf170f`
- Android：`022423aa1516e56ddc0d0e80806e9732af2022fe97e4736e89da6b146dad8edc`

## 未検査・未接続

この検査は、v2実サービス同期、異なるOS間の同一グループ収束、通知、OSバックグラウンド実行、本人専用Calendar同期の成功を意味しない。通常の作業領域・既存グループの移行・本番Rulesは変更していない。続きは[進捗](05-progress.md)へ記録する。

## Phase 4e追記：過去の実施入力

基点`0891594dd8ae16e3724ccbfbbe1d7b5ea8cadea5`へのPhase 4e差分、未公開ルール`liflow-shared-2-draft-11`で再検査した。両端末とも「フローリングを掃除する」の家事回を開き、「以前実施した」から前日2026年10月27日の12:30を入力、明示的な記録ボタンで保存し、履歴を開いた。

実施は10月27日12:30、登録は10月28日00:28として分離され、実施者・本来担当・登録者も別の項目として表示された。共通基準日を本人の推奨日で置き換えて保存しない。検査DB以外への書き込み・クラウド送信は行わない。

最初のiPhoneの実行では時刻欄がキーボードの下にあり、操作できなかった。iOS用のキーボード回避と共通フォーム容器を追加し、XCTestもScrollView内をスクロールするようにした。Androidの最初のスクリプトは入力欄ではなく同名のラベルを選んでいたため、実際のクリック可能な入力欄を選ぶよう直した。その後の成功記録は次のとおり。

- `phase4e-iphone-past-fixed.xcresult` / `.log`：XCTest 1件成功。キーボード入力、保存、履歴表示。
- `iphone-past-fixed/`：画面・アクセシビリティツリー。履歴画像のSHA-256：`d6ac175e16d02f550bd19d61c1212f4e2097c1cbdddc4f1b5564305341be6797`。
- `phase4e-android-past-fixed.log`：保存・履歴表示成功。52.69秒にはADBの階層取得・入力・スクロールを含む。
- `android-v2-past-history.png` / `.xml`：履歴画像のSHA-256：`6ca499a31784f6c96a971df1c12c6c2edcbbcf6407e9e7228f868ee03e3e8c23`。
- `phase4e-ios.log` / `phase4e-android.log`：各1130件成功、lint・型検査通過。
- `phase4e-cloud.log`：Emulator結合25件成功。

代行の承認待ち・管理者承認と取消・他人による取消ボタンの非表示は実SQLiteを使う自動画面検査で確認した。今回の実機では合成した1ユーザーのみを使っており、これを複数の実アカウントによる代行E2Eとして報告しない。

## Phase 4g追記：時刻変換の修正後の通常入力

基点`89809022b8a708b15b83e8c0330d279171958997`へのPhase 4g差分、未公開ルール`liflow-shared-2-draft-13`で、両実機の東京の過去実施入力を再検査した。時刻の重複がない場合に不要な選択肢を出さず、前日の12:30を実施日時として保存・履歴表示できた。

- `phase4g-iphone-past.xcresult` / `.log`：XCTest 1件成功。`iphone-phase4g/`に画面とツリー。履歴画像SHA-256：`0cde5d9c6ec23c0d3506f6276069103eed9fc51d8a0213b2873dfc95670fb2b6`。
- `phase4g-android-past-confirmed.log`：入力・保存・履歴表示成功。54.59秒にはADBの階層取得・入力・画面取得を含む。`android-phase4g-past-history.png`のSHA-256：`e991c76e473041ff039083abbad6bde738de2e481da3c83b2636c0d8025232d8`。
- Androidの最初のスクリプトは、読み込み中にも見える検査の注意書きだけを待ち、準備完了前に家事を探して失敗した。実際のホーム見出しの表示を待つように直し、成功した実行を上記へ分けて保存した。
- `phase4g-previous-reference-repro.log`：前版と修正版による、二度ある時刻の基準回の比較。
- `phase4g-ios.log` / `phase4g-android.log`：各1141件、lint・型検査成功。`phase4g-cloud.log`：Emulator25件成功。

重複時刻の選択と将来の繰り返しの確認状態は、ホスト地域を変える純粋検査と実SQLiteで検証した。今回の実機再検査は東京での通常入力であり、重複時刻の実機操作は未実施である。

AndroidのPhase 4eの画像・XMLは、後続検査で同じ名前へ保存したため原ファイルが上書きされた。当時のhash・操作ログとiPhone側の原画像は保持している。Phase 4gの画像は上記の独立名へ保存し、以後のADB検査は実行ごとの別ディレクトリへ出力する。


## Phase 4j追記：日時変更と最新入力の保持

基点`6928227`へのPhase 4j差分、未公開v2 draft17。両機種のSDK58パッチを再ビルドし、更新前後で既存primary SQLiteの全テーブルが同一であることと整合性を確認した。検査DBは独立したsynthetic scopeとし、実グループへ移行していない。

- Android：`phase4j-android-batch-past.log`（54.07秒）でほこり取りの過去実施日時・実施者・登録者の履歴を確認。`phase4j-android-batch-date.log`（70.40秒）でフローリングの翌日指定・戻ったカード・再入力値を確認。ADBの取得・入力・スクロール時間を含み、描画速度の測定ではない。
- iPhone：`phase4j-iphone-date17-retry.xcresult`で日時変更の基本動作1件成功（26.69秒）。これは最新入力保持の修正前。修正後の連続操作は、スクロール対象に本文以外の45ptの領域を選んでいた検査コードと、アプリ外画面の割り込みを切り分けて再検査中。初回のAutomation mode開始タイムアウトや中断した検査を成功へ数えない。
- `phase4j-final-batch-ios.log` / `phase4j-final-batch-android.log`：各1176件、失敗0・スキップ0。`phase4j-batch-final-lint.log` / `phase4j-batch-final-types.log`通過。`phase4j-final17-cloud.log`：Emulator25件成功。
- `phase4j-input-batch-before.log`と`phase4j-warning-revision-before.log`：描画前保存と古い確認の再現。`phase4j-batch-and-warning-confirmed.log`：修正後の関連45件通過。

端末内画面と保存の検査であり、DSTの実機検査・実Firebaseサービスでのv2端末間同期・BackgroundTask実行保証として扱わない。証跡は`/tmp/liflow-v2-20261027/`に保持し、失敗分も上書きしていない。
