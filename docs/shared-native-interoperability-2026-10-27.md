# 共有同期の物理端末相互運用検査（2026-10-27）

対象はUSB接続中のSony I4293（Android 10 / API29）とiPhone 12（iOS 26.7.1）、署名付きDebug開発ビルド。Expo58・React Native0.88。Mac上のFirestore Emulatorを使い、テスト専用の `demo-liflow-sharing` プロジェクトと架空の3ユーザー（所有者と各端末）で検査した。実Google認証・本番Firestoreの検査としては扱わない。

公開コードと同じ暗号、保護されたSQLite、SecureStore、repository adapter、Scheduler、送受信coordinator、Firestore client、Security Rulesを使う。診断コードだけを一時的な開発ルートへ置き、試験後はアプリのソースから除外する。実際の個人家事やGoogleの認証情報はテスト用クラウドへ送信しない。承認はテスト所有者が行い、本番の明示的承認フローは省略しない。

| シナリオ | 確認結果 |
| --- | --- |
| 両端末の参加承認と鍵更新 | それぞれ別の端末鍵で参加し、鍵version3のSnapshotから組み込み20家事を取得。全てOFFの状態が一致。 |
| Androidで家事を有効化 | iPhoneでも同じ安定した家事回ID・予定へ収束。 |
| 両端末で同期前に同じ家事を完了 | 各端末のOutboxに1件ずつ保持。送信後、元の完了事実は2件、画面用の有効完了は1件。 |
| iPhoneから取り消し | 観測済みの完了事実を指定して取り消し、Androidへ反映。有効完了0件。 |
| 同期前に周期をAndroid17日・iPhone9日へ変更 | 同じ項目の競合を1件として検出。影響する家事の予定を停止し、暗黙に片方を採用しない。 |
| Androidで9日を明示的に採用 | 両端末の競合0件・9日周期・同じ予定へ収束。 |
| 所有者がSnapshot公開 | 共有状態を維持し、受信位置51まで適用。 |
| プロセス終了・再起動 | 両端末で鍵、SQLite、9日周期、受信位置51を保持。 |
| 空の保護SQLiteへ復元 | 元のDBを削除せず、別の新規ファイルにSnapshotから再構築。両端末の共有状態が一致。 |

各収束点で、家事ID・有効状態・周期、家事回ID・予定日・状態、完了の対象と結果を正規化してSHA-256で比較した。最後の状態は両OSとも `ee9662cb05e8…`、未送信0件、競合0件、9日周期。単にAPIがHTTP200を返したことをPASSの根拠にはしていない。

同期前の編集検査では、端末内保存後に送信処理を呼ばずOutboxに残し、その後に明示同期した。機内モードのUI全体を操作した検査ではない。途中切断・再送・重複・改ざん・長期オフライン・除名後の拒否は、別の結合テストでも検査している。

両端末のタイムゾーン計算は、同梱tzdb2026eを使う7例（Mexico City、Coyhaique、Tokyo、Kathmandu、New YorkのDST gap/fold、Lord Howeの30分移行）で同じハッシュになった。AES-GCM、鍵wrap、改ざん拒否、SecureStore、バックアップ対象外の保存先、排他的SQLiteトランザクションも両端末で確認済み。

個人DBは検査前後で、households・members・家事定義・家事状態・担当者・依存関係・完了履歴・家電・ゴミ登録・ゴミ非表示・Google Task紐付けの**11テーブルの全行が一致**した。SQLite整合性も両方 `ok`。Androidは21家事・家電1台・完了1件、iPhoneは20家事・家電0台・完了1件を保持している。共有テストのための初期化・アンインストールはしていない。

Androidでは最初、QRの枠だけが表示される問題を実機で発見した。Expo ImageのAndroid data URI loaderがpercent-encoded SVGを処理しないため、端末内生成のbase64 GIFへ変更。実画面の1080×2520 PNGを独立したjsQRで読み取り、元の招待リンクと完全一致した。リンク本文やQRそのものは公開記録へ含めない。

残る検査は、実Googleアカウントを使う共有画面全体、iOSの招待QRの目視・独立読取り、OSが自然に起動するBackgroundTask、Apple実サービス認証、独立したセキュリティ監査。直近のAndroidはインターネット未接続で、通常・明示の両GoogleログインがPlay servicesの `Account reauth failed` となった。接続復旧後の実Google認証は未検証。iPhoneの画面操作もMacロックのため保留している。
