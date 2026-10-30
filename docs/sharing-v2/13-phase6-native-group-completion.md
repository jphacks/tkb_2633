# Phase 6：同一グループの異種OS総合検査

2026-10-29、基点`7549e28`、`codex/encrypted-group-sharing`、[Draft PR #6](https://github.com/jphacks/tkb_2633/pull/6)。元指示書§16のPhase 6（開発回帰検査）を、最新D10・D11に従って完了した。次は指定された全ページUI・UXの調整。本番配備・一般公開の完了とは区別する。

## 検査した経路

接続中のiPhone 12（iOS 26.7.2、XCTest）とSony I4293（Android 10、ADB）を使用した。同じ合成グループへ、通常v2と同じSession、最新参加状態を確認するcontroller、画面、SQLite／Outbox、署名・暗号化、Firestore SDK、現在のSecurity Rulesを接続した。

保管先はローカルの`demo-liflow-v2-native` Emulatorのみ。認証は検査用のmock UIDで、実Firebaseアカウントのログインをこの総合検査で再実施したという意味ではない。実GoogleアカウントのTasks・Calendar、本人専用の暗号化同期、通知のOS配達は、[先行実機記録](12-untimed-daily-load.md)と既存の独立した証拠へ分けている。グループ転送は明示的な同期で操作し、起動・前景・backgroundの契機と時間枠・排他は既存の自動検査・先行実機記録で照合する。

検査用の招待の種だけは公開の固定fixtureとした。端末の秘密鍵、グループ鍵、payload用乱数は通常のNative乱数・AES・保護保存を使う。招待entropyそのものの本番検査とは扱わない。検査用UID、グループ、registry、ledgerを分離し、個人DB・既存v1・Googleデータを初期化しない。

## 実機で照合した結果

- iPhoneで作成し、Androidの参加申請を所有者が承認。鍵世代2、2メンバー、共通状態・予定のhashが一致。
- 両端末でSDK通信を停止し、同じ共通家事を完了。各1件のOutboxを保持し、実プロセス終了・再起動後も元の操作・履歴hashが一致。
- 通信を戻して再送。2人の元の実施履歴を残し、完了した共通家事回は1つ。双方の状態・予定・履歴hashが一致し、Outboxは0件。
- Androidで本人分だけ取り消しても所有者の完了は残る。所有者が残りを取り消すと未完了へ戻り、2件の元履歴は保持。
- 通常の名前編集・自動保存を両端末で使用。オフラインで異なる値を保存し、受信後は2候補を表示。所有者が両候補を確認して明示選択すると再収束し、Androidの再起動後も状態・予定・履歴・receiptが一致。
- 解決時の共通状態hashは`02ee6f055b5ea9cf0629a4456624b97aa6989115cfd118295bc4ed66e84472b6`、両端末のOutbox 0件、確認済みreceipt 36件。
- 別UIDの読取を両Native SDKで拒否。所有者がAndroidメンバーを除名すると鍵世代3へ更新され、新世代の鍵の配布先は所有者1端末だけ。AndroidはRulesで読取を拒否され、通常のv2画面にも家事操作を表示しない。元履歴は所有者側で保持。
- サーバーの36イベントに合成家事名の平文がないこと、salt／nonce／鍵世代の組が36件で重複していないこと、36件の不変receiptとSnapshot位置36を確認。有限の観測であり、乱数や暗号の数学的安全性を証明したという意味ではない。

全ての結果は[機械可読の証拠](evidence/2026-10-29-phase6-native-pair-and-completion.json)へ記録した。生の画面・ログはローカルに保持し、公開するのは合成データの照合値とhashだけ。途中の失敗を成功へ読み替えず、ツール・経路の誤りと再実行を別記した。

## 見つけた不具合と変更

共有家事一覧で、検索キーボードに結果が隠れ、dragでも閉じられない状態をiPhoneで再現した。仮想化を維持し、検索結果へのタップを受け取る設定、dragによるキーボード解除、iOSだけのキーボードinsetを追加した。Androidは既存のadjustResizeへ二重補正を加えない。既存の1,000件リスト・一般メンバー権限の回帰を強化し、iPhoneで検索→編集→自動保存、およびキーボード表示→drag解除→最初のタップで編集する経路を実行した。

[React NativeのScrollView仕様](https://reactnative.dev/docs/scrollview)と[FlatListの継承するprops](https://reactnative.dev/docs/flatlist)を、Expo SDK 58／RN 0.88に照合した。

検査側では、キーボード予測欄を含む安全な操作範囲、checkboxの要素型、UIAutomatorの直列化、EmulatorのLAN用8186とloopback用8185を区別した。Android IMEで最初の文字列が変換されたため、以後は最終入力値も照合した。検査画面の不具合と通常アプリの不具合を混同しない。

## 自動回帰と変更の範囲

- iOS条件 **2,180/2,180**、Android条件 **2,180/2,180**、Firestore Emulator **71/71**。失敗・skip 0、lint・型検査の終了コード0。
- 既存325機能契約を内容ごと保持し326契約へ拡張。必須Cloud回帰41件。追加3件と、実Sessionを使うCloud総合1件、既存の両OS検索回帰の補強。
- 開発検査入口を設定へ追加し、releaseでは表示・実行しない。QAの接続先・UID・保管先の検証は、DBや鍵を開く前に行う。Rootの一時ボタンは成果物へ含めない。
- 主な追加先は`development/v2-native-pair`のcore／Native接続／画面とQA入口。通常アプリ側の変更は検索リストのキーボード操作と開発時だけの入口。受信schema、共通Scheduler `draft-36`、Native依存・設定は変更していない。
- 作業前のcheckout差分・未追跡`artifacts/`を保持。本番Rules／schema、main、Draft状態は変更していない。個人DB全ファイルを今回あらためてbyte比較したという主張ではない。

## 完了判定と後続

元指示書の必須30ケースを、現在の両OS成功ログ・テスト名・source hashへ照合した。[ケース表](08-phase6-case-matrix.md)と証拠に範囲を示し、全30境界をそれぞれ両物理端末で再実行したという意味にはしない。D10は「時刻なしを時間帯の競合・移動から除外し負荷だけ確認」、D11は「既存v1を保持して新規v2を先行」として反映済み。

本番v2有効化、mainマージ、Draft解除・一般公開は別承認のまま。OS任せの長時間background実行の評価、独立した外部監査、有料Appleチームによる実サービス設定、既存v1の変換提供は後続。新しい負荷kind単独の実OS配達を今回の成功に追加していない。

次はホームの時刻・0件表示、9段階の安定した並び順、即時反応とカード密度、分類／家事スイッチ、連結した設定・説明と固定Back、数値・手順・入力・記号の整列、家事の区別、家電のBack、全ページの両実機確認を行う。
