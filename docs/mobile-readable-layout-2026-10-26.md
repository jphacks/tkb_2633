# スマートフォンの文字・戻る操作・カレンダーの改善

## 依頼と対象

前回の本文15〜16ptでは拡大が不十分だったため、本文・補足・操作の文字サイズを画面間で共通化した。戻るボタンの実装を統一し、カレンダーの縦方向の空白を削減した。

更新元は確認時の `origin/main`、`c249d30a849fbb2bef21638a00e9e52f2362b3d6`。

## 変更した内容

### 共通の文字サイズ

`src/components/planner-typography.ts` を追加。文字を画面の役割に応じた共通定義へ置き換えた。

| 用途 | サイズ / 行高 |
| --- | --- |
| 画面タイトル | 32 / 42 |
| セクション見出し | 24 / 34 |
| 本文、家事名、手順、注意事項、豆知識 | 22 / 32 |
| ボタン、選択肢、項目ラベル | 20 / 28 |
| 補足、分類、件数、出典URL | 18 / 26 |

本文を拡大した画面は、ホーム、家事一覧・個別設定、家事の説明、家電一覧・解析入力・保存済み詳細、設定、ゴミ収集日、履歴、ヘルプ、初期設定。入力欄も22ptにし、通常の入力欄の最小高さを54ptへ調整した。

### 戻るボタン

`planner-ui.tsx` に `BackButton` を追加した。

- 全画面で同じ22ptの「戻る」と、同じ形の左向き矢印を使用。
- 操作領域の最小高さは48pt。
- 家事の分類・豆知識、家電の詳細・解析入力、設定、個別設定、ゴミ、履歴、ヘルプ、初期設定へ適用。
- 家事・家電が見つからない場合の戻る操作も統一。
- 分類一覧・豆知識一覧の戻る操作を画面上部に配置。
- 既存の遷移先とアクセシビリティの戻り先名を維持。

### カレンダー

`src/app/(tabs)/explore.tsx` を変更した。

- 日付セルの最小高さを52→36pt、週の行間を6→0ptに変更。
- 0件の日には点・横棒の部品を描画せず、空の表示領域をなくした。
- カードの上下余白、月見出しとの間隔、ページ内の間隔を縮小。
- 日付は18→20pt、曜日は15→18pt、ゴミ名は12→16ptへ拡大。
- 「可燃ごみ」「粗大ごみ」は末尾の「み」だけが孤立しないよう2文字ずつで折り返す幅を設定。表示名・読み上げ名の文字列は変更していない。
- 予定のない週は短く、ゴミ名のある週は内容に合わせて必要な高さを確保。
- 同じ週の選択日・今日・ゴミ収集日の枠は同じ高さを使用。
- 月移動時の選択日保持、毎週の曜日表示、隔週・毎月の日付表示、非表示にした毎週収集日の灰色枠を維持。
- 点の色分け・個数と完了の紐付けは既存の回帰テストで確認。

### 拡大に合わせた配置の調整

- 家事カードの家事名の2行制限を外し、長い家事名も折り返して表示。
- 完了チェックの見た目を23→28ptへ拡大。
- 手順番号の幅を拡大し、本文と同じ行高へ統一。
- セクション見出しと件数、ホームのリンク、設定の状態表示は横幅に応じて折り返す。
- 設定の曜日ボタンは最小44pt、数値入力は幅64ptへ拡大。
- 設定のカレンダー色名・色見本・プレビューに必要な幅と折り返しを確保。
- 設定の増減操作を40pt幅・44pt行高へ調整。
- ゴミ収集日の予定カードは日付側に最小160ptを確保し、操作ボタンを必要に応じて次の行に配置。
- ホームの今週・来週の選択領域を最小44ptへ拡大。

### タブの文字切れの修正

375pt幅のiPhone SEで、拡大したタブ文字が画面下端で切れることを発見した。タブ文字を16pt・行高22ptにそろえ、タブバーを64pt＋端末の下部安全領域へ変更した。

ホームにはタブバーを以前の高さへ戻す独自指定も残っていた。`src/components/planner-tab-bar.ts` に寸法をまとめ、ホームとタブ全体で同じ定義を使うよう修正した。初期設定中のタブ非表示も確認した。

## 変更ファイル

| ファイル | 内容 |
| --- | --- |
| `src/components/planner-typography.ts` | 共通の文字サイズを追加 |
| `src/components/planner-ui.tsx` | 共通の文字、戻る操作、見出しの折り返し |
| `src/components/planner-tab-bar.ts` | 端末の安全領域を含む共通タブ寸法 |
| `src/components/app-tabs.tsx` | タブ文字と高さ |
| `src/components/task-checkbox-row.tsx` | 家事名・分類・チェック・長い名称 |
| `src/components/chore-schedule-card.tsx` | 家事カードの文字 |
| `src/components/chore-source-links.tsx` | 参照元の文字 |
| `src/components/accordion-section.tsx` | 折り畳み見出しの文字 |
| `src/app/(tabs)/index.tsx` | ホームの文字・折り返し・選択領域・タブ寸法 |
| `src/app/(tabs)/explore.tsx` | カレンダーと下部カードの配置 |
| `src/app/(tabs)/guide.tsx` | 説明・手順・道具・注意・豆知識・戻る |
| `src/app/(tabs)/manual/index.tsx` | 家電一覧・追加ダイアログの文字 |
| `src/app/(tabs)/manual/appliance-care.tsx` | 解析入力・解析結果の文字・戻る |
| `src/app/(tabs)/manual/appliances/[id]/index.tsx` | 保存済み家電の文字・戻る |
| `src/app/chores/index.tsx` | 家事一覧の文字・戻る |
| `src/app/chores/[id].tsx` | 個別設定の文字・入力・戻る |
| `src/app/settings.tsx` | 設定の文字・入力・色見本・数値操作・戻る |
| `src/app/waste.tsx` | ゴミ設定の文字・予定カードの折り返し・戻る |
| `src/app/history.tsx` | 履歴の文字・戻る |
| `src/app/help.tsx` | ヘルプの文字・戻る |
| `src/features/onboarding/first-run-setup.tsx` | 初期設定全6画面の文字・戻る |
| `src/features/waste/waste-schedule-editor.tsx` | 設定と初期設定で共用するゴミ入力の文字・曜日操作 |
| `tests/mobile-navigation.test.mjs` | 戻る・初期設定の往復・タブ寸法の回帰テスト3件 |
| `tests/helpers/screen-harness.mjs` | 安全領域のネイティブAPIのテスト代替を追加 |
| `docs/feature-contracts.json` | 今回の操作・表示の回帰テストを必須登録 |

## 確認結果

- `npm run check`：lint・型チェック成功、270件すべて成功。
- 既存267件のテストを保持し、今回の3件を追加。必須の機能契約は17件。
- iOS・Androidの本番JavaScript書き出しを実行。
- iOS 27の開発ビルドで確認。iPhone SE（375pt幅）とiPhone 18 Pro Max（440pt幅）の画面を使用。
- 家事の説明・手順・戻る、ホーム、家電一覧・保存済み詳細、ゴミの入力、設定の開閉を操作。
- 小型iPhoneでカレンダー直下の家事カードとタブ文字を確認。月を移動しても元の日付・家事が保持されることも確認。
- 初期設定は頻度→休日→家事選択→前回実施日→地域→ゴミの6画面を操作し、固定フッターと本文を確認。
- 初期設定の表示確認は専用QA端末のDBをバックアップして実施し、終了後に全行の内容が一致する状態へ復元した。

今回の端末確認はiOS。Androidは本番JavaScript書き出しと自動テストの確認。

## 確認画像

- [家事の説明（大きいiPhone）](screenshots/mobile-readable-layout-2026-10-26/guide-large-iphone.png)
- [ゴミ収集日（小型iPhone）](screenshots/mobile-readable-layout-2026-10-26/waste-iphone-se.png)
- [初期設定（小型iPhone）](screenshots/mobile-readable-layout-2026-10-26/onboarding-iphone-se.png)
- [カレンダーの余白とカード配置の確認（小型iPhone）](screenshots/mobile-readable-layout-2026-10-26/calendar-iphone-se.png)

カレンダー画像の撮影後、ゴミ名を14→16ptへ追加拡大した。最終コードの日付は20pt、曜日18pt、ゴミ名16pt。
