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

## Phase 4n追記：Androidの共有カレンダーと過去実施

基点`29146f7`へのPhase 4n差分、未公開v2 draft21。Sony I4293（Android10/API29）の同じ独立検査DBで実施した。LiFlowを再インストール・初期化せず、実サービスの受付や別アカウントを偽装していない。iPhoneは手動確認待ちで操作していない。

- `phase4n-android-calendar.log`：`calendarMonthPastWorkAndHistory=true`、43.627秒。共有カレンダーの前月・次月を開き、7日前の10月21日を選び、浴室の回を12:30に実施した記録を保存した。戻った選択日の未完了数は0になり、完了カードと実施者、記録日10月28日の履歴が残ることを確認した。この回は実施期間の終了が5日前の境界に当たるため、「ホームの期限を明確に過ぎた実機検査」とは数えない。15日前の回は別の両OS条件の実TSX・SQLite検査で確認した。
- `android-phase4n-calendar/calendarPastCompleted.png`：SHA-256 `7d0b0370a9114ac164b7615534a0030d9fc9dc26fcaf70f1a1ea015c8dbe6035`。
- `android-phase4n-calendar/calendarWorkHistory.png`：SHA-256 `c38ea240efd3304e22e6ad590be1edfc4fef0661b00fa111d5df47a04e12a1d2`。
- `android-phase4n-calendar/calendarWorkSaved.png`：SHA-256 `4c18689ed3ef47aa804e62c7b4260447736d5d5c9338e0a6ced2648f02570d0b`。
- 画像の確認後、週ごとにCard共通gapが加わる余白を除き、凡例を短くした。読取専用の`phase4n-android-calendar-compact.log`は`calendarCompactReadOnly=true`、7.605秒。新しい完了を追加せず選択日と完了カードを再表示した。`android-phase4n-calendar-compact.png`：SHA-256 `9bbee939ae5b5d5296dc9e432c9cf87a186df1238d9f49f37256ff011900d15f`。元画像は別名で保持した。

操作は公開UiAutomationのアクセシビリティAPIであり、座標タップ・ソフトウェアキーボードや実アカウント間E2Eの成功には数えない。今回の全件検査は両OS各1281件、Emulator25件、機能契約166件。最終余白調整後の関連32件・lint・型検査も成功した。

## Phase 4o追記：Androidの今回だけ解除と次回の保持

基点`5be8784`へのPhase 4o差分、未公開v2 draft22。新しい契約のため別の合成検査領域を開き、旧検査DB・primary DB・実グループを保持した。LiFlowの再インストールや初期化は行っていない。

`phase4o-android-scoped-cancellation.log`：`scopedRemovalPreservesFuture=true`、54.084秒。フローリングを翌日にずらして2週間の指定を保存し、今回だけの解除が初期選択であることを確認して明示保存した。同じ回を再表示すると元の10月28日に戻り、共有カレンダーで次回の家事回を開くと11月5日の指定が保持されていた。最初の元指定の期間は10月28日〜11月10日で、今回の解除で全期間を消していないことを確認した。

- `phase4o-scopedCancellationChoices.png`：SHA-256 `0366932272af8ed9db8e16da35d5c936f0f4336307043da13a9815a4fc0d4635`。解除の元期間と範囲選択を確認した。下端の選択肢全体は画像に収まらないため、選択状態の確認はネイティブ要素のchecked状態も照合した。
- `phase4o-scopedCurrentRemoved.png`：SHA-256 `a291f9217cb7c69643b3971e9206b9cd26ffb1b3742869cc73c52d1b7efc7252`。
- `phase4o-scopedFuturePreserved.png`：SHA-256 `01a912e3b34671d0f7c31880a7c78c2f47eb3bc68d5a859ecdddfaaee23e4104`。次回の入力欄が11月5日を保持することを確認した。

公開アクセシビリティAPIでの実表示・端末内保存であり、座標タップ・ソフトウェアキーボード・実サービスの本人承認E2Eとは区別する。iPhoneは入力確認待ちのまま操作していない。両OS条件各1290件、Emulator25件、機能契約169件が通過した。

## Phase 4p追記：解除申請を追加した後のAndroid端末内回帰

基点`925dcf7`へのPhase 4p差分、未公開v2 draft23。`phase4p-android-scoped-regression.log`は`scopedRemovalPreservesFuture=true`、61.602秒。一般メンバー向けの申請を追加した後も、既存の管理者による2週間指定→今回だけ解除→再表示→次回の11月5日の指定保持が動くことを確認した。独立した合成検査DBを使用し、旧検査領域・primary DB・実グループを保持した。

- `phase4p-scopedCancellationChoices.png`：SHA-256 `7dafee71b6a7ad7a945f7454ba15274d1deeaaf6ea60f645dd985a0945d6bf72`。
- `phase4p-scopedCurrentRemoved.png`：SHA-256 `ff5f7d9218335ef1f084ada92c5f8ee22ab8b86c445d069bffc87e4f0a631622`。今回の入力欄が10月28日に戻ることを確認した。
- `phase4p-scopedFuturePreserved.png`：SHA-256 `f35228292367b0dd25bea6bdd75c99c48bcce2124736c912ac4c4531a2ef33e6`。

公開アクセシビリティAPIの検査であり、今回の一般メンバーの解除申請・本人承認は実TSX、署名付きSQLiteとFirestore Emulatorでの検査である。物理端末の実サービス承認E2Eへ数えない。iPhoneは手動確認待ちで操作していない。

## Phase 4t追記：新規家事の有効化と周期の自動保存

開始点`710ad8c`への通常ワークスペース接続差分。Android 10のSony I4293で、既存アカウント・個人DB・実グループを使わない開発用の合成検査DBを使用した。LiFlowを再インストール・初期化していない。検査補助APKは別パッケージのまま更新し、各操作の前にLiFlowかつ開発用画面であることを再検査する。画面から外れた場合は操作を中断する。

最終の`phase4t-android-initial-final.log`は`initialActivationAutosaveAndReopen=true`、36.154秒、終了コード0。未設定の「トイレを掃除する」を開き、メンバーごとの家事として7日周期で有効化した。その後、数値を8へ変更し、自動保存完了を待ち、戻って同じ家事を開き直すと8日が保持されていることを確認した。

- `phase4t-initialConfiguration.png`：SHA-256 `cb3a442314241cfa9bcce271fd65f1ca27b59ed34ffca91c429376fd9f8e71c6`。
- `phase4t-initialActivated.png`：SHA-256 `dd2643579029e7e36a639c2c7a45daf8a1f8ca96082b87512ec954a9c256c754`。
- `phase4t-initialAutosaved.png`：SHA-256 `42a2e61377dc37036f0ba9e2b630be6f8a2e352392761f8fcc5af886f60cb5a1`。
- `phase4t-initialReopened.png`：SHA-256 `04193823608f8e88c623cb3a44c69e869ae44dde9b17cf76302fa2e4e2e9852a`。周期8日の実表示を画像でも確認した。

先行する試行には、DevClientランチャーに留まったもの、こちらのコード反映による再読込で中断したもの、戻った先の見出しが画面外で検査ツールが停止したものがある。これらを成功へ数えずログを保持した。コード編集を止め、開発用画面へ入った後の操作に限定し、戻った先の実際のスクロール位置に合わせて確認した最終試行を上記の成功とする。

この検査は公開アクセシビリティAPIでの入力・表示・端末内保存の検査で、ソフトウェアキーボードや座標タップの検証とは区別する。通常v2の実サービス・実アカウント間同期やiPhoneの新しい画面操作をPASSとしたものではない。通常ルートの選択・保護・前景更新は両OS条件の実TSX検査、通常作成と受付はFirestore Emulator・SQLiteとの結合検査で確認した。

初期設定の数値欄は通常の自動保存欄と同じ、左にラベル・右に数値の配置へ揃えた。`phase4t-android-layout-verified.log`は`initialCompactLayoutReadOnly=true`、3.679秒、終了コード0。未設定のレンジフードを開いて新しい配置を読み取りのみで確認した。`phase4t-initialCompactLayout.png`のSHA-256は`9238d5c1b8b4c50a95879fc0cb3635fce55a7ecde5929bba8d319d3b22b3517d`。この確認では家事を有効化・保存していない。スクロールで開発用の目印が画面外となり安全側で停止した先行試行も、成功へ数えず保持している。

## Phase 4u：Android 10、個人家事の重ね表示

Sony I4293 / Android 10（API 29）、同じLiFlow development buildとMetroポート8101。実アカウント・個人DB・既存共有グループを操作せず、`personal=1`付き開発用リンクが新規に用意した独立した個人／v2検査DBを使用。別パッケージのUiAutomation helperだけ更新し、LiFlowの再インストール・データ消去は実施していない。iPhoneは依頼済みの手動確認待ちで、この検査は未実施。

- 1回目：23.832秒、code 1。ホームの完了・取消と手順表示まで進んだが、長い手順のスクロールでQA識別表示がaccessibility treeから外れ、操作を停止。安全確認を弱めず、QA画面だけに固定の識別表示を配置した。
- 2回目：41.283秒、code 1。カレンダーで保存すると一覧を一度空にする既存処理が働き、位置が先頭へ戻った。個人の件数は0へ更新済みだったが、チェック済みカードの確認を続けられなかった。修正前のTSX検査でも`data`が空になる失敗を両OSで再現した。
- 3回目：22.435秒、code 0、`privateHomeCalendarCompletionUndoAndInstructions=true`。以前の検査用完了だけを明示的に取り消してから、ホームとカレンダーで完了・取消、手順開閉、共有の送信待ち不変、件数の1→0→1を確認した。カレンダーの完了後・取消後ともカードが同じスクロール位置で表示された。画像も確認済み。

3回目のローカル証跡は`/tmp/liflow-v2-20261027/phase4u-android-private-third.log`、画像一覧とSHA-256は`phase4u-native-evidence.json`。主な画像：

| 画像 | SHA-256 |
| --- | --- |
| `phase4u-privateHomePending.png` | `15b923fd25f8111801ee77cee499ae68085946cdfe5a20358f46c108d2251272` |
| `phase4u-privateHomeCompleted.png` | `9a1f9b40155fc2674546cbb390373fa26e372307b1967065e383b0535b9a2270` |
| `phase4u-privateCalendarCompleted.png` | `af5b3bdaaec721f399ff2068608041c6755855680df8009642c7f89eef1717da` |
| `phase4u-privateCalendarUndone.png` | `8b90d9f40aaec376b0b76475869448f5b2103b867c22c546b8ed7a6a48294df7` |

棒モードでは合計2件と3件が同じ区分なので、上部マーカーの2枚は同一画像となる。個人件数の0／1はnative accessibility labelのassertionで検査しており、画像だけで差を判断したとは扱わない。初回・2回目の失敗ログも保持し、最終成功に含めない。本番v2共有、iOSの今回の画面、個人Calendarの同一人物端末同期、v2 Google Tasksや通知が実サービスで通ったという証跡ではない。

## Phase 4aa：共有ゴミ収集日と実際の入力

未公開v2 draft30の独立した合成検査領域を使用。検査での変更操作はこの領域に限定し、LiFlowの再インストール・初期化、個人DBや既存グループの手動変更は行っていない。Androidは別パッケージのUiAutomation helperだけ更新し、iPhoneは既存のXCTest補助アプリを更新した。ユーザーから、iPhoneで手動タップするとキーボードが出ることと、Androidを給電できる接続へ変えたことの回答を受領し、給電は実際の`dumpsys battery`でも確認して検査を再開した。

Android 10 / Sony I4293では毎週・隔週・毎月の3件を登録した。その後の再開検査`phase4aa-android-waste-final-attempt.log`は50.472秒、code 0、`sharedWasteThreeModesHideRestoreAndEditReopen=true`。当日分をホームから隠し、共有カレンダーで再表示し、毎月の日付を17に変更して編集画面を開き直し、保存値を確認した。登録の実行は先行する検査で行い、再開検査で同じ3件を再作成したとは数えない。

最初は古い開発ビルドに留まったため正しいMetroへ接続し直した。その後、戻り先で保持されたスクロール位置と、表示されていないStack内のScrollViewを検査が混同する失敗があった。さらに画面から消えたチェックをAndroidの古い要素情報で参照する失敗も記録した。helperはQA識別表示の実際の可視性を必須にし、表示中のScrollViewだけを操作し、候補要素を`refresh()`してから照合するよう修正した。新しいUiAutomatorのXMLと画像でもホームに対象カードがないことを独立確認した。これらの先行失敗は保存処理の不具合として数えず、ログを保持する。

iPhone 12 / iOS 26.7.2では`phase4aa-iphone-waste-input.xcresult`と`.log`のXCTest 1件が24.937秒で成功。実際のソフトウェアキーボードを開き、`PET`と入力してペットボトルの候補を選び、毎月の日付を17へ入力・保存し、開き直した入力欄で17を確認した。先行する自動化準備のタイムアウトと、アプリのaccessibilityが準備できる前のDeep Link操作は失敗として保持。数値の先頭にカーソルを置いて削除したため値が変わらない検査も、実映像で原因を確認してカーソルを末尾に置く手順へ直した。入力のassertionを弱めたり、型付けした入力を別手段のDB更新で代用したりしていない。

実機画像で、ゴミ名のない日付がセル中央へ下がる配置と、太い選択枠だけ数字が2px下がる配置を確認した。個人カレンダーと同じ上揃えにし、線幅の差を内側の余白で相殺した。最後の読取専用検査`phase4aa-aligned.xml`と`phase4aa-calendar-native-aligned.json`では、25〜31日の数字7つすべての上端が1672px、下端が1745pxで一致することを検査した。この最後の確認は予定を追加・保存しない。

ローカル証跡は`/tmp/liflow-v2-20261027/`。Androidの画像一覧とSHA-256は`phase4aa-native-android-evidence.json`、iPhoneは`phase4aa-native-ios-evidence.json`。主要画像を目視確認した。

| 画像 | SHA-256 |
| --- | --- |
| `phase4aa-final-sharedWasteCalendar.png`（最終揃えの前） | `d7bee9a703508cc6d2dce4aff9476c511d5da93131459d73ff6f06df94e4534f` |
| `phase4aa-final-sharedWasteReopened.png` | `05da14a2e2ff5e4f4596c6f92e9daabb01f0550394c8a0d2aceac0d8348c903c` |
| `phase4aa-calendar-native-aligned.png`（最終配置） | `ca133157bcf5f28352b710564904439b4bb804c08c0fb2c716c6eedff7d86653` |
| iPhone `v2-waste-native-keyboard-after-direct-tap` | `8ce130964a11f8f86d235c731247ff9d6534833bb420c75784d80b99dcf7c06d` |
| iPhone `v2-waste-native-reopened` | `7b4e83ffd95f9405169f52ba809e7401d1ab10fa961b9d396138b1b15e56ace7` |

両OS条件の実TSX・SQLite検査は各1480件、Firestore Emulatorは27件で成功した。これはv2実アカウント間同期、Google連携、バックグラウンド実行、全新画面の成功を表すものではない。Androidは検査後に再び全給電がfalseとなり、後の画像では残量6%だった。充電状態を推測せず、次の継続した実機操作の前に再確認する。
## Phase 4ac：共有家電の入力と実APIを使った端末内保存

2026-10-28、既存の開発ビルド・端末データを保持したまま実施。AndroidはSony I4293 / Android 10、iPhoneはiPhone 12 / iOS 26.7.2。共有クラウドへの書込・実グループの移行は実施していない。

Androidの`phase4ac-android-native-form-final.log`は11.566秒、code 0。メーカー・製品名・型番の3欄へNative Accessibilityから入力し、BackButtonで一覧へ戻った。この段階ではAPIと保存を実行していない。iPhoneの`phase4ac-iphone-appliance-form-final.xcresult`はXCTest 1件、24.060秒で成功し、実際のソフトウェアキーボードで3欄へ入力して一覧へ戻った。先行する起動待機の失敗、検査スクリプトの戻るラベル指定間違い、端末が他画面になっていた間の失敗は、これらの成功と分ける。iPhoneはユーザーの再開確認後に成功した。失敗ログは残し、この実行で作った不要な失敗時録画・診断のexportは削除した。

実APIの`phase4ac-real-api-check.log`では、既存のlocalhostサーバーへのDyson SV20のリクエストが62.149秒でverifiedの10項目を返した。`forceReanalysis`を指定しておらず、新しい推論を強制した検査ではない。その実応答のSHA-256は`1326efc043be1a05380b544db90f50402d9e9c7577b0f1fd51a520501ef18ee2`。独立したSQLiteへの検査で、未確認の拒否、10件の無効追加、同一内容の再試行0操作を確認し、実グループ書込0・共有クラウド送信0を記録した。検査用のレビュー印を人間の本番同意として扱わない。

Android実機では、127.0.0.1:8787へのADB転送を一時的に設定し、実APIの応答を画面で取得した。選んだ1項目を無効の家事として保存し、開き直して手順・公式リンクを表示した。最初のAccessibility操作は下端の確認ボタンで止まった。QA画面、確認済みの状態、新しいボタン座標を検査し直してADBの実タップで保存し、`phase4ac-android-real-api-native-reopen.log`の7.462秒、code 0で復帰を確認した。

下部safe areaを反映した後の`phase4ac-android-real-api-native-final.log`は58.355秒、code 0。実APIからの取得・項目選択・レビュー・保存・開き直しを実行し、既にある同じ内容の再保存で新規家事0件を検査した。Accessibilityの更新直後は画像が前フレームのことがあるため、その場の画像名だけでは成功としない。最後に戻った画面を再取得し、実描画と要素情報の両方で0件を確認した。API URLのCLI上書きを外してMetroを通常設定へ戻し、一時転送8787は残していない。8101の開発用接続は保持した。Androidは残量6%時点で消灯し、最後の短い照合では充電中・7%だった。

このAndroid検査は「実API + 端末内v2プレビュー」であり、異種OS間の実サービス同期E2Eではない。iPhoneのフォーム入力成功も、iPhoneからの実API通信の成功とはしない。公開Rules、実グループ移行、本人Calendar・v2 Tasks・通知／Widgetを含むE2Eは引き続き未完了。

ローカル証跡は`/tmp/liflow-v2-20261027/`。一覧は`phase4ac-native-android-evidence.json`、`phase4ac-native-ios-evidence.json`、`phase4ac-native-android-real-api-evidence.json`、`phase4ac-real-api-local-review-evidence.json`。主要画像を目視確認した。

| 実画像 | SHA-256 |
| --- | --- |
| Android・3欄入力 | `5f04b12b41008ffdcb3924815eaec5318dbf76e63267c8957a6fefb345513480` |
| iPhone・ソフトウェアキーボードでの入力後 | `c3e221b2154cf6e17bc2af917c24aa2917e69560043112767a1b7d23b99bfa02` |
| iPhone・一覧へ戻った状態 | `146b06fde6ac7b3b9975692de6a0822f4d330cff0a8c6d5f8ee6789a0645658c` |
| Android・実APIで保存した家電の開き直し | `a5dc0131321aba0e38d58e786170631d75a6ae5b44ee0c96d552d1102e27add4` |
| Android・再保存で新規0件の実描画 | `533e435f6fcd3dee2dffaa732dd82b92b228c3f42a5671929325bcd5c58bfed7` |

## Phase 4ad：共通の中止処理をNative navigationへ接続した後の確認

`phase4ad-iphone-appliance-form.xcresult`のXCTest 1件は31.399秒で成功。iPhone 12 / iOS 26.7.2で、共有家電の入力欄を実際のソフトウェアキーボードで編集し、Nativeの戻る操作で一覧へ復帰した。共通のblur/unmount listenerが接続された画面の入力・遷移の確認であり、通信途中のblurを実APIで実施した検査ではない。その競合は`phase4ad-blur-before.log`、`phase4ad-delayed-before.log`、`phase4ad-save-lock-before.log`の反例と、`phase4ad-save-lock-after.log`の40件で確認する。

画像一覧は`phase4ad-native-ios-evidence.json`。入力後の実画像SHA-256は`f8df6dbb3371609c719b1217cbb9114e84b2f31fc02c18f5d703789598cb1caa`、一覧へ戻った実画像は`9c33c036694ced123d5a5d51c18414443263a57b241fb9846d99f681b31f89dd`。入力後を目視確認した。Androidの新しいNative検査は追加しておらず、低残量の端末は消灯したまま充電する。

## Phase 4af：名前・地域の自動保存と元地域の指定

`liflow-shared-2-draft-33`の独立した端末内データを使用した。LiFlowの再インストールやデータ初期化はしない。Androidはユーザーによる再接続後、Android 10・残量61%・AC給電を確認し、8101の開発サーバー転送を戻した。更新したAPKは検査補助アプリだけである。

iPhoneでは実キーボードで翌日の19:00〜19:30を東京の指定として保存し、グループ名を`LiFlow Region QA`、地域をニューヨークへ変更して、戻る操作の自動保存を行った。保存後に「今日」の家事を探す検査は、翌日に移したため停止した。同じSQLiteを消さず、カレンダーから翌日を開くXCTestへ続け、**19.735秒・成功1件**で元の19:00・Asia/Tokyoと、新規入力欄の06:00・America/New_York、保存済み設定の再表示を確認した。起動先のAccessibility未準備や開発サーバー選択の失敗は成功に含めない。

AndroidのADB・実アクセシビリティ操作では、同じ日時指定から名前・地域の自動保存、カレンダーからの開き直し、元指定の保持、新規入力の06:00、設定の再表示まで**42.793秒・code 0**。検査の起動先はmanifestのinstrumentation定義を使い、補助アプリの誤った起動指定は成功へ数えない。最初の画像には遷移中の旧画面や開発用のFirebase接続警告が重なったため、要素情報の成功と実描画の確認を分ける。警告自体を製品コードで非表示にはしない。

| iPhoneの実画像 | SHA-256 |
| --- | --- |
| 保存済みの名前・America/New_York | `b27b7418a16048ff83078e20bd719a72f635855a355aa917bc3fd552df38b962` |
| 元の19:00・Asia/Tokyo | `0ccd9f1c18e64246b18ccb74bbd9f05b797a07d29b5042ffa60546822d770603` |
| 新規入力欄の06:00・America/New_York | `7cdba7bf78ae1335c8d936e371a3eaa01db367f0d69d4cc798966259ec566f64` |

一覧は`phase4af-native-ios-evidence.json`と`phase4af-native-android-evidence.json`。両端末のローカル操作の確認であり、異種OS間のv2実サービス同期やバックグラウンド実行の保証とは扱わない。共有検査用のOutboxは未送信で保持し、サーバー受付を捏造しない。

## 12. 本人Calendarの独立したNative暗号検査

`development/private-calendar-preview`のメモリ内の合成データだけを使った。アカウント、個人DB、SecureStore、本番Firestore、既存の共有Outboxへ接続しない検査関数であり、両端末それぞれで実行した。端末間の実通信ではない。SHA-256の既知値と非空AADのAES-GCM／OpenSSLのwire一致、独立した本人鍵の受渡し、20,000区間・22片の逆順復号、重複・改ざん・別鍵・旧メイン・解除端末の拒否など、12項目が完了してから成功表示を出す。

| 環境 | 最終の自動操作 | 関数内の合計 | 準備／暗号化／復号／拒否検査 |
| --- | --- | --- | --- |
| 物理iPhone・XCTest | 8.003秒、成功1件 | 2,338ms | 256／417／826／839ms |
| 物理Android 10・ADB補助 | 11.593秒、code 0 | 9,952ms | 1,094／2,355／3,183／3,320ms |

初期実装の合計はiPhone10,211ms・Android41,957msだった。大きい16進暗号文の再JSON化を避け、同じSHA-256をNativeで処理する。portable実装との形式の一致も自動検査した。拒否検査では同じ大きいcacheの再確認も行うため、上記をそのまま通常の同期時間とは扱わない。日常画面で毎回再復号しない通信・保存層への接続は、引き続き必要である。

最初のAndroidの待ち切れは、検査関数がその後に成功していても自動操作の成功に数えなかった。iPhoneの最初のAccessibility未準備も失敗として保存し、起動経路を切り分けた。最終の操作は以前のPASS表示を拾わず、新しい検査の開始または新しい実測表示を確認している。LiFlowを再インストール・初期化せず、更新したAPKはAndroidの検査補助だけである。

| 最終実画像 | SHA-256 |
| --- | --- |
| iPhone、PASS 12件・2万区間・22分割 | `a80e94db1d41542783834fbeca02a8aeb31558fb2f8903d424fd82ec50a0c8de` |
| Android、PASS 12件・2万区間・22分割 | `cc8b365a4c4a6ba131afd034c2de1ee001cc2494ddff8420af6991e3d12343d9` |

画素と要素情報を照合し、`phase4ag-native-and-code-evidence.json`へソースのdigest、環境・範囲・結果と合わせて記録した。本番Rules、実アカウントの時間帯、グループの移行、main、READMEは変更しない。


## 13. 本人Calendarの保存鍵とプロセス再起動

`development/private-calendar-store-preview`で、合成QA専用のUID・Keychain service・SQLiteだけを利用した。鍵そのものを画面やlogへ出さず、合成鍵のSHA-256照合値と公開の端末ID・authority digestを比較した。両端末で、秘密鍵を使う署名検証、保護したauthorityの復元、保存鍵の一致、Native AES-GCMの4項目が通過した。

| 環境 | 初回保存 | プロセス終了後の再読込 | 再起動前後の比較 |
| --- | --- | --- | --- |
| 物理iPhone・XCTest | 8.160秒 | 9.144秒 | 端末ID・authority・合成鍵照合値が一致 |
| 物理Android 10・ADB補助 | 6.022秒、code 0 | 5.567秒、code 0 | 同上、プロセスID変更も照合 |

Androidはforce-stopと起動、iPhoneはdevicectlのterminate-existing指定と新しいプロセス起動を行った。これは**アプリの再起動**であり、OS再起動やOS任せのバックグラウンド動作の成功へ拡大解釈しない。実データの初期化、LiFlowの再インストール、実アカウントへの接続・クラウド保存は行わない。releaseではQAの操作とQA用保存先を拒否する。

| 実画像 | SHA-256 |
| --- | --- |
| iPhone初回 | `18f57fce840f5b35f10dfaae953d650f62abef7b3497c7e5674cb96e117dd392` |
| iPhone復元 | `45c1a241929279cfe5c3c3ad7195af8b35c4dd20f49e6e7507f5a86182102c67` |
| Android初回 | `8f8ae7226a4a72973e5e737c56ac6a5471c42be574be42f475012334f25ccbf6` |
| Android復元 | `e883a91ccd03297700cc4120e8f8dd5e308e075e57ba66bfbcd808ca27fc9903` |

実行記録と比較は`phase4ah-native-and-code-evidence.json`へ保存した。本人用クラウド同期や異種OS間の共有E2Eは引き続き未完である。


## 14. 本人Calendarの暗号化SQLiteとアプリ再起動

`development/private-calendar-cache-preview`の明示ボタンから、合成QA専用UID・service・DBで2万区間・22片を検査した。保護保存の4項目に、既存cacheの有無、完全な暗号文とcursorと送信待ちの同時保存、同じ暗号文の再送待ち、確認後の再登録防止と全区間復元の4項目を加えた。画面には秘密値を出さず、QAの公開照合値・連番・片数のみ表示する。

| 環境 | 初回 | プロセス終了・再起動後 | 結果 |
| --- | --- | --- | --- |
| 物理iPhone・XCTest | 14.325秒 | 16.461秒 | 8項目ずつ成功、SQL cache復元後に連番1→2 |
| 物理Android 10・ADB補助 | 36.110秒、code 0 | 41.292秒、code 0 | 同上、プロセスIDも変更 |

復元回は既存cacheの復号も行う。初回と復元回を性能改善の前後比較にしない。Androidの最初の再起動検査は開発clientの画面準備前で止まり、routeだけを開き直して同じ保存値から成功した。iPhoneのterminate-existing指定も結果JSONで確認した。OS再起動・長時間のbackground実行・端末間の実通信を検査したという意味ではない。

| 実画像 | SHA-256 |
| --- | --- |
| iPhone初回 | `dfab9a2fdb94c20da67f700e1bff7e5a1afb3857d6a11f456d49077628d02b8f` |
| iPhone復元 | `cacbed87a3a21874e71d6fc0b6168d2d3e2e0d4d407eed4c77e04489f3344503` |
| Android初回 | `cc8402c852876636d18b5aca5f39f2a9ef08a0c9969e7a893e5166d21f404af5` |
| Android復元 | `149540398ba18bc0cfbc3a535648a94a571b98f961002c88a415572ca1c76340` |

全画像とQA要素情報を確認し、`phase4ai-native-and-code-evidence.json`へ範囲と結果を保存した。実Google/Firebaseアカウントの情報、本番Rules、元個人DB、共有Outboxはこの検査へ使わない。


## 15. 生成端末の固定後の旧Native保存値互換性

Phase 4akではメイン切替時の鍵生成担当を修正した。旧QA保存値を使い、両端末で署名・authority復元・鍵の再読込・Native AES-GCMの4項目を確認した。Androidは4.987秒、iPhoneは8.018秒で成功。両端末の端末ID・authority digest・合成鍵の照合値はPhase 4ahから変化していない。

iPhoneの初回2回はXCTestがUI自動化の準備で停止した。ユーザーに確認画面がないことを確認し、Mac/iPhoneの接続を切り分けて検査用のtestmanagerdを再接続した後に成功した。初回失敗は成功へ数えず、端末やアプリの初期化・再インストール・端末再起動を行わない。この検査も実アカウントや端末間のメイン変更E2Eの成功とは扱わない。

| 旧保存値の確認画像 | SHA-256 |
| --- | --- |
| iPhone | `413b2a983015556bae3ecb512f0ee8de9284c1bdf4ae46688db21ace297f5dce` |
| Android | `1f0e9f94ba7d51f439b0ccf8c272b1bfcfb1d0c8b0772a078159ef4a7337225a` |

範囲・失敗・照合結果は`phase4ak-native-and-code-evidence.json`へ記録した。


### 本人Calendar初回設定：実受付後の中断、復旧、確定後cold起動

専用demo projectのFirestore Emulatorと合成UIDを使用し、iPhoneとAndroid 10から実SDKで通信した。準備4項目、プロセス終了後の復旧6項目、確定後のプロセス再起動と復元6項目が両端末で成功。端末ID・root、確定後の鍵の公開照合値を各段階の要素情報から照合し、6枚の画像も確認した。別UID拒否も実Rulesで確認する。iPhoneは7.113／8.920／8.038秒、Androidは4.824／11.925／8.091秒。異なるstageなので性能比較はしない。

初回のcold起動は開発clientの接続画面へ戻って検査前提で止まった。既存Metroへの接続後に同じ保存先で継続した。失敗は`phase4am-*-root-resume*`、成功は`phase4am-*-root-restored*`と`phase4am-*-root-ready-cold*`、合成公開照合値と画像hashは`/tmp/liflow-v2-20261027/phase4am-native-and-code-evidence.json`へ保存した。実アカウント・個人DB・旧QAを保持する。端末間同期・実Google・OS再起動・背景実行の成功とは扱わない。
