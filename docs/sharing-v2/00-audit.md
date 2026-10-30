# グループv2：Phase 0監査

調査日：2026-10-27。製品仕様の正本は[統合仕様](01-specification.md)。この文書は実装開始前の状態を記録する。

## 作業基点

- Repository：`jphacks/tkb_2633`、作業ブランチ：`codex/encrypted-group-sharing`。
- HEAD：`f9d472ffd6aac50d58d7fe2ff728410cf1117b99`。リモートの共有ブランチと一致。
- リモートmain：`62d05771872fbd7124ec4ba5715f79ca290cb56b`。Draft PR #6。
- 共有worktreeに未コミットの追跡対象変更はなく、既存の未追跡`artifacts/`のみ。削除・取り込みをしない。
- 元のcheckoutはmain `1e9c9fb` に多数の別変更がある。読み取り確認だけにとどめ、今回の保存先に使わない。
- 受領したv2指示書のSHA-256：`a1ed9140f873cabd9bffdbace3d931fa1bed5d424d62592073276e400d8c684c`。
- `artifacts/spec-handoff-*/LiFlow_spec_handoff_2026-10-27/00_START_HERE.md`を確認。3組とも参照は`1c4150c`で現行より古い。manifestを保ち、収録コードをworktreeへ上書きしない。

## 照合した資料とソース

`AGENTS.md`、README、[既存共有設計](../shared-groups-design.md)、[共有編集監査](../shared-group-editing-audit-2026-10-27.md)、[信頼性監査](../workspace-reliability-audit-2026-10-27.md)、[実機相互運用](../shared-native-interoperability-2026-10-27.md)、[全体構成](../architecture.md)を現行実装と照合した。

主な実装の確認先：`features/sharing/{operations,replica,planning,mutations,roster,crypto,synchronizer}.ts`、`platform/storage/{sharing-ledger,sharing-registry,sharing-projection,shared-planner-repository}.ts`、`platform/sharing/workspaces.ts`、Calendar coordinator/client、通知digest、ホーム・カレンダー・共有画面。

全体構成の「初回設定5段階」「AI・同期は外部サービスを呼ばない」は歴史的な記述で、現在の6段階設定・実装済みAPI接続とは異なる。v2の仕様根拠にしない。READMEと共有設計の最新の検証値は888テスト・84機能契約で一致している。過去の監査の862などは当時の記録として保持する。

## 実装済み・部分実装・未実装・矛盾

| v2要件 | 現状 | 根拠・差分 |
| --- | --- | --- |
| 個人DBとグループDBの分離 | 実装済み | DBをアカウント・グループ・再参加世代へ固定。個人履歴の自動取り込みなし |
| 暗号・署名・認可・Outbox・Snapshot | 実装済み | 署名付き因果イベント、100件単位、原子的保存、固定暗号文の再送。新しい業務権限まで実装済みという意味ではない |
| 家族／同居人と既定値 | 未実装 | settingsにグループ種別・個別既定値がない |
| 管理者1人・所有権移譲 | 部分実装 | 所有者UIDと所有端末による署名済みrosterを維持。家事単位の日時権限・委譲はない |
| 4種類の家事 | 未実装 | assignmentはあるが、各人の独立完了・完了条件はない |
| 本人だけの個人家事の重ね表示 | 未実装 | 現在の画面は選択中のDBのみ。共有DBへのコピーで実現しない |
| 共通期間と個人別推奨日 | 現行と異なる | v1は全端末で推奨日も一致し、私的Calendar・天気を除外。v2は共通の家事回と期間だけを一致させ、推奨を別計算する |
| 本人専用Calendar・メイン端末 | 未実装 | グループ鍵の所持者全員が復号できるため、その鍵による本人同期は不可 |
| busy開始・終了と鮮度 | 部分実装 | FreeBusy clientは区間を取得するが、保存は日別合計だけ。v2用の私的区間保存を別途用意する |
| 期限／実施日／固定日時 | 未実装 | 日付単位のSchedulerと実施期間のみ。時刻付き手動ルールはない |
| 今回／期間限定／無期限・例外 | 未実装 | 期間の上書き分割・家事回例外・ルール版が必要 |
| 変更申請・猶予・代替案 | 未実装 | 端末時計のみで承認を確定する既存経路もない |
| 固定時刻の重複拒否・負荷警告 | 部分実装 | 日単位の負荷と依存順を計算するが、担当者ごとの時刻重複を扱わない |
| 個人家事の条件付き移動 | 未実装・判断待ち | 実施可能な時刻帯がない。深夜を含む既定帯を勝手に作らない |
| 引き受け・解除・暫定担当 | 未実装 | 同時assignmentの競合をそのまま引き受けの意味へ流用しない |
| 途中参加・担当変更・退出後の待ち | 部分実装 | roster参加・退出と再参加世代はある。家事回からの適用境界と再割当待ちはない |
| 代行・本来担当／実施者／登録者 | 部分実装 | 完了本文に実施者、署名に登録者の情報はあるが、当時の本来担当や承認状態は保持しない |
| 登録者または管理者による取消 | 現行と異なる | v1は観測済みの同一家事回の有効完了をまとめて取り消す。v2では操作権限と対象事実を別に検証する |
| 過去の実施日時入力 | 未実装 | 現在の操作時刻による完了が中心。記録時刻を独立させる必要がある |
| 2〜6日間隔／7日以上の共通周期 | 現行と異なる | v1は完了を周期へ反映する。v2の共通枠は個人の完了で動かさない |
| 仮想消化と実完了の分離 | 部分実装 | 個人engineに概算・経過周期がある。v2の家事回ごとの未完了履歴と短周期抑制は別に設計する |
| ホーム期限超過5日・過去完了 | 現行と異なる | 現行のホーム等は3日を使う箇所があり、過去の未完了枠の操作も不足。個人の既存契約を一括変更しない |
| 担当者別通知・完了通知設定 | 部分実装 | namespace分離と取消はあるが、共有digestに担当者の絞り込みがない |
| 競合を因果関係で保持 | 実装済み | v1の複数値レジスタ・対象を指定するundoを保全。引き受け競合だけは処理を続行するv2表現が必要 |
| 必須／任意の依存関係 | 部分実装 | 順序・循環拒否は実装済み。任意依存の警告と手動日時の検査はない |
| Google Tasksの本人・家事回対応 | 部分実装 | ユーザー／作業領域の対応と双方向取消を実装済み。v2の各人実施・代行権限との接続が必要 |
| 新旧端末混在時の停止 | 部分実装 | 未対応schemaとScheduler版は拒否するが、v2を有効にする明示移行とクラウドの旧書込拒否は未実装 |

## 維持する直近の修正

| 再発させない動作 | 主な回帰検査 |
| --- | --- |
| ゴミの旧画面で最新ルールを戻さない・削除を復活させない | `sharing-repository`、`waste-search-and-storage` |
| ゴミの周期・曜日・基準日を1組で競合解決 | `sharing-planning`（Snapshot後を含む） |
| DB待ち・保存中・競合解決中に許可を照合 | `sharing-repository`、`sharing-workspace-recovery` |
| 共有の日付による初期値・競合案内 | `sharing-repository`、`sharing-planning-notice` |
| 古い画面更新・古い通知の再公開を抑止 | `planner-refresh-controller`、`planner-workspace-lifecycle` |
| 他グループの障害・worker時間切れを分離 | `sharing-workspace-recovery`、`sharing-workspace-provider` |
| 初期化失敗時の接続解放・再参加世代の照合 | `sharing-workspace-recovery`、`sharing-registry` |
| 同じメンバー情報で予定を再計算しない | `sharing-repository` |
| Googleの認証主体・権限・キュー・取消・100件上限 | 既存Google同期・native auth・Calendar stress各検査 |
| Androidのheadless待機の寿命・QRの表示 | `expo-headless-timer-lease`、招待QR検査と既存実機記録 |

## 重大な設計差分

1. v1操作はschema1、entity/fieldのallowlistは固定。v2情報を任意のJSONへ隠して運ばない。新しいプロトコルと受信権限の検証が必要。
2. 現行`parseSharedCloudGroup`とRulesはメタデータを厳格に照合する。本番のschemaやRulesを変更せずにv2へ自動昇格させることはできない。移行は所有者の明示操作と別途の本番承認を要する。
3. 共有鍵はグループ全員向け。本人専用の同期は別鍵・別のUID認可・別の信頼pinを要し、グループ管理者に復号権限を渡さない。
4. 現行Firestoreイベントの`createdAt`はRulesで`request.time`に固定するが、受信契約では捨てている。期限付き承認には、端末の申告時刻と区別したサーバー受領証拠が必要。
5. 共通Schedulerのv1契約は`liflow-shared-1 / tzdb2026e`。その意味を上書きせず、v2の共通枠と私的推奨を別に版管理する。

## 検証記録

基点の既存記録は888テスト／OS、Firestore Emulator20件、84契約、CI4件成功。今回の開始時にも両OS条件の再実行を開始した。実際の再実行結果・変更後の結果は[進捗](05-progress.md)へ追記し、過去の記録を今回のv2のPASSへ読み替えない。

Phase 0の結論：既存の保護基盤は再利用できるが、v2の多くは未実装。既存データを一括変換したり、v1の権限・完了・Schedulerの意味だけを差し替えたりして実装しない。
