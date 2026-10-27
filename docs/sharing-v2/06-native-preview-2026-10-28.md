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

## Phase 4k追記：Androidのアクセシビリティ操作とiPhoneの未解決入力

基点`fbcf4bb`へのPhase 4k差分、未公開v2 draft18。LiFlowのprimary DBや実グループを変更せず、既存の独立した合成検査領域を使用した。今回の実機では申請の承認・代替提案を実サービスへ送信していない。

Androidの座標操作では画面が切り替わらない失敗が残ったため、公開APIの`UiAutomation`・`AccessibilityNodeInfo.ACTION_CLICK/ACTION_SET_TEXT`を使う専用検査APKで切り分けた。LiFlowのDBやJSへ値を注入せず、実際の要素操作とコールバックから保存する。検査APKは別package・自己targetとし、LiFlowのインストール・データを置換しない。成功は次の範囲に限定する。

- `phase4k-accessibility-date.log`：19.960秒、翌日2026-10-29の指定・明示保存・戻ったカード・再入力値を確認。`android-action-date/dateReopened.png`のSHA-256は`d00d8abeb12fe474f747c19cff7b11f65b810212a659f66a48e13e2a12960720`。
- `phase4k-accessibility-past-ready.log`：16.998秒、2026-10-27の12:30を実施日時に保存し、2026-10-28の記録日時・実施者・登録者を履歴で確認。`android-action-past/pastHistory.png`のSHA-256は`3162967ab62c1f5c4b56ce382901490879b4c011468b6a8953ceeccf04787bca`。
- `phase4k-accessibility-requests.log`：6.283秒、ホームから別ルートの申請一覧へ移動し、申請がないことを正しく表示。`android-action-requests/requestsEmpty.png`のSHA-256は`ad90d75af7b5debc5604bb0750da968d58d8fe99fc85ba1fc7a91e5931f9bdfe`。一覧へ入るためのダミー申請は作成しない。

これらはソフトウェアキーボード入力や座標タップを通した検査のPASSではない。所要時間には要素待ち・入力・画像保存を含み、描画性能の測定ではない。最初の過去入力検査は条件付き欄の描画前に探して失敗したため、対象欄を待つ修正後の実行を別名で保存した。

iPhoneは個別ルート化後も入力欄にキーボードフォーカスを得られず、`phase4k-iphone-distinct-date`と`phase4k-iphone-native-inset`は失敗として保持した。フォーム容器の試験変更は改善しなかったため元へ戻した。映像と要素情報が一致しない状態で入力を続けず、本人へ手動タップでキーボードが出るか確認を依頼した。端末のロック状態情報だけから入力可能と断定せず、原因をOS・Compiler・アプリに特定したとは扱わない。

コード検査は`phase4k-complete-ios.log`・`phase4k-complete-android.log`各1209件成功、lint・型検査成功、`phase4k-cloud.log`のEmulator25件成功。実TSXの15ルート検査、申請回答UI20件、別SQLite間の受信と期限・権限・固定重複・必須依存関係を含む。実機の空一覧の成功を、複数アカウントによる申請回答E2Eの成功として扱わない。証拠は引き続き`/tmp/liflow-v2-20261027/`に保持する。

## Phase 4m追記：Androidの担当指定と申請入口

基点`8bb6383`へのPhase 4m差分、未公開v2 draft20。Sony I4293（Android10/API29）で、一人の合成グループを使い、実際のSQLite・署名付きOutboxへ保存した。iPhoneの操作は確認待ちのため再開していない。

- `phase4m-android-assignment-switch.log`：`assignmentSaveReopenAndRequestList=true`、31.653秒。家事回から担当フォームを開き、次回の基準日を確認して今回だけへ戻す。本人を選択・明示保存し、戻ったカードと再表示したSwitchの選択状態を確認した。ホームから担当申請一覧へ移動し、空状態を表示した。
- `android-phase4m-assignment/assignmentReopened.png`：SHA-256 `889b22d5ffd304e752508adb17b85a1d38b2da6a3cab46779717f89fc6ef0ddb`。選択が保持され、今回だけの適用範囲と現在の担当を実表示で確認した。
- `android-phase4m-assignment/assignmentRequestsEmpty.png`：SHA-256 `9bbf93b3359e8473b69007857097a92088ddf4038a7437964ca1a4b5fbd0c5f8`。ダミー申請を作らず空状態を確認した。

最初の`phase4m-android-assignment-native.log`は検査ヘルパーの新モードが反映されておらず、従来の家事回表示の検査だけだった。担当指定の成功に数えない。続く`confirmed`と`ready`の実行は、同じ名前のTextとSwitchを取り違えて停止した。ヘルパーを、表示中で操作可能なネイティブ要素を選んで待機するように修正してから上記の成功を得た。失敗分は保持し、LiFlow側の処理変更で検査を通したものではない。

標準UiAutomationのアクセシビリティ操作であり、座標タップ・ソフトウェアキーボード・Googleアカウント間承認・バックグラウンド実行のPASSではない。所要時間は画面待ち・操作・画像保存を含み、描画速度の測定ではない。再インストールしたのは独立した検査APKのみで、LiFlowのデータを初期化・置換していない。

`phase4m-full-ios.log`・`phase4m-full-android.log`はCIと同じ`HOUSEWORK_TEST_PLATFORM`指定で各1261件成功、失敗0・スキップ0。lint・型検査通過。`phase4m-final-cloud.log`はEmulator25件成功で、将来の周期に対応した担当指定とSnapshot復元を含む。コード検査、端末内操作、実サービス同期の範囲を混同しない。
