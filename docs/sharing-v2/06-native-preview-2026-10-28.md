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
