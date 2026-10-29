# 既存グループ移行の準備・検査（Phase 6未完了）

## 1. 開始状態

2026-10-29、ブランチ`codex/encrypted-group-sharing`、HEAD `ca8d131b720070741e9199abdce7e7d971e244ba`。今回の準備開始時は、以前からの未追跡`artifacts/`のみを保持。元のcheckoutを編集せず、既存のDraft PR #6で検証を続ける。

## 2. 読んだ契約と直前の修正

元のv2指示書、`01-specification.md`・`02-architecture.md`・`03-verification-plan.md`・D3/D10、309機能契約、署名・roster・Snapshot・receiver・SQLite・workspaceのガードを照合。直前の通知キュー／予約容量／未配信清掃、個人コピーの限定SQL読取と実機証拠を保持する。

## 3. 実装範囲

実装したのは、暗号化されたv1移行元の検証、所有者の種別選択を受けるプレビューのコア、隔離した新SQLiteへの受信検査。プレビューの`mayActivate`は常にfalse。所有者向けの通常画面・家事別変換・家事回alias・私的Google対応・世代参照の切替は未実装であり、この準備を実移行とは扱わない。

## 4. 変更と理由

- `legacy-migration-source.ts`：保護されたpin・期待するmanifest digest／位置と、署名付き履歴・暗号文・元の作者を検証。JSON descriptorだけを権限の根拠にしない。非同期入力固定、鍵コピーの消去、元のreceiptとfactの照合を行う。
- `legacy-migration-preview.ts`：実施者と登録者、対象取消、同時編集を保持。記録にない担当・登録時刻を作らず、端末互換性も推測しない。
- `receiver-authority.ts`：検証済みの同じsource objectと正確な移行境界だけを認める。未確認のdescriptorは受信処理を確定しない。
- `replica.ts`：混在するv1/v2のSnapshot整理後も元の移行証拠を保持。従来v1だけの整理は維持する。
- `payload-schema.ts`・`scheduler-contract.json`：未公開v2をdraft-35へ進め、新しい依存も照合。公開v1は変更しない。
- `sharing-v2-legacy-migration.test.mjs`・機能契約：署名・改ざん・旧メンバー・非同期変更・4,100receipt・SQLiteロールバック・更新後の復元を保護する。

## 5. 実行した検査

最終ソースで各OS条件2,094/2,094、Emulator70/70、失敗・skip 0。lint・型は終了コード0、311契約で元の309を維持。新規10件と既存Snapshot6件の16件も成功。修正前の混在履歴の整理は9/10で失敗し、元factを落とすことを再現した。Native依存・設定に変更はなく、直前のDoctor20/20は別時点の証拠。新しい実機E2Eを行ったとは報告しない。

## 6. 既存データ・暗号・Googleへの影響

実個人DB・実v1グループ・本番Firestoreへは書き込んでいない。暗号primitiveを新設せず、既存の認証付き暗号と作者署名を利用する。鍵をcheckpointやプレビューへ保持せず、Google ID・Calendar本文やbusyを共有へ加えない。旧Nativeの鍵・DB・Outboxを初期化しない。v2旧draftとの版不一致は隠さず検出し、保存先を黙って変換しない。

## 7. 残件と判断待ち

- 所有者画面、家事ごとのポリシー・基準日・旧回alias、本人Google対応の確認、別DB世代での変換検証と原子的な参照切替。
- 実個人予定の移動・理由・履歴。D10の元時刻がない場合の方針を回答待ち。
- Mac解除後のiPhone Tasks・コピー・完了通知と異種OSの総合E2E。自然な背景動作も強制workerの成功とは分ける。

## 8. 再開位置

現在の検証器とプレビューを所有者用の移行準備サービスへ接続する。確定直前に同じsource checkpoint・最新の権限・未送信・端末対応を照合し、新しいDB世代だけに構築する。失敗・中断では元のDB・鍵・参照を保持する。実グループや本番Rules、mainマージ、Draft解除は、具体的な結果を揃えた後の別承認対象。全ページのUI調整はPhase 6完了後。

## 9. PRと証拠

[Draft PR #6](https://github.com/jphacks/tkb_2633/pull/6)。現在のcommit識別子とCIはPRで確認し、[機械可読の証拠](evidence/2026-10-29-legacy-migration-source.json)に基点・source hash・成功／反例ログhashを保存する。過去の証拠は上書きしない。
