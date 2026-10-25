# Google Tasks Phase 0〜1 実装・確認結果

2026-10-25 / Asia/Tokyo

## 対象

- Branch: `codex/google-tasks-sync-phase1`
- START_SHA: `1e9c9fbb6ca6745b1501319456d05ff3bd92c491`
- ORIGIN_MAIN_SHA: `e14e085288adab85a3df591d6c587c80f5f6e2d0`
- 最新main統合後の実装コミット: `1feb38084837c166347b7cdbfc01785daba5dfc5`
- Expo SDK: `58.0.19` / React Native: `0.88.0`
- Push: NO

最新mainの家事カード重複防止と設定アコーディオン改善を取り込みました。ホーム・カレンダーの新しい表示ロジックと共通アコーディオンを使い、家事完了時のGoogle同期呼び出しを組み合わせています。

## 実装

| 項目 | 内容 |
| --- | --- |
| OAuth | `react-native-nitro-google-signin` 2.3.0経由でGoogleのネイティブSDKを使用 |
| 認可範囲 | `https://www.googleapis.com/auth/tasks` |
| 資格情報 | Google SDKが管理。アプリ独自のSecureStoreやSQLiteにはtokenを保存しない |
| オフラインアクセス | ユーザー選択により端末内方式。`offlineAccess: false`、バックエンドなし |
| 同期方向 | 家事Planner → Google Tasks |
| Task List | `家事Planner` |
| 通常同期 | 最終成功から24時間経過後 |
| 一時失敗 | 約1時間後に再試行。429の`Retry-After`が長ければそちらを優先 |
| バックグラウンド | 最小間隔60分のworker。実際の実行時刻はOSが決定 |
| 前面での再試行 | 起動・復帰・手動同期・アプリ側完了 |
| 二重起動防止 | プロセス内の実行中Promiseを共有。中断した保存状態は手動同期から再開 |
| 保存 | SQLite v14に同期状態とschedule entry / Google Task対応表を追加 |
| Phase 2 | Google側完了 → アプリの完了は未実装 |
| Phase 3 | Calendar FreeBusyとScheduler連携は未実装 |

認証方式は、端末内方式というユーザーの選択に合わせ、Google SDKによるログイン・token更新を使っています。iOSではKeychainに保存されたログインのサイレント復元を行い、SDK呼び出しを自動同期から対話的なログインへ進めません。iOS development buildで認可とTasks APIへのアクセスを確認しました。

## 実アカウントで確認した結果

以下は最新main取り込み前の同期用ブランチで行った確認です。ユーザーが画面を操作し、端末SQLiteは読み取り専用で照合しました。

| 項目 | 結果 | 根拠 |
| --- | --- | --- |
| Google OAuth接続 | PASS | 本人のGoogleログイン・Tasks権限許可後に初回同期成功 |
| 専用Task List | PASS | APIが返したTask List IDを端末に保存 |
| 一方向の予定作成 | PASS | 「食器を洗う」180件に異なるGoogle Task IDを保存 |
| Calendar表示 | PASS | 提供画像で10月26〜31日に1日1件ずつ表示 |
| 再同期の重複防止 | PASS | 本人が26日は1件のままと確認。全180件の対応IDも一致 |
| アプリ側完了 → Google完了 | PASS | アプリから26日の予定を完了にし、本人がGoogle側の完了を確認 |
| 再起動後の認証復元 | PASS | 完全終了後も本人が再ログインせず同期操作できた |
| 中断後の手動同期 | PASS | 修正後に完了表示を確認。12:34:09 JST開始の同期が成功状態`idle`へ復帰 |
| 予定日・家事名変更 | 実アカウントでは未確認 | 既存の同期ロジックのテストには同一Taskのpatchケースあり |
| Android / iOS実機のバックグラウンド | 未確認 | 今回の操作対象はiOS Simulator |
| BackgroundTask登録の実行結果 | 未確認 | Simulator上の登録成功を示す独立した記録は取得していない |
| 接続解除 | 実アカウントでは未確認 | 解除時にGoogle上の既存Taskを残す実装 |

12:36 JSTの端末確認では、同期有効・状態`idle`・最終成功記録更新済み・再試行回数0・エラーなしでした。対応表180件の全IDは初回同期後と一致し、ローカル完了記録2件を確認しました。

## コードの確認

| 項目 | 結果・対象 |
| --- | --- |
| lint | PASS — 最新main統合後に`npx expo lint`を実行 |
| typecheck | PASS — 最新main統合後に`npx tsc --noEmit`を実行 |
| git diff --check | PASS — 最新main統合後 |
| 同期関連テスト | 統合前に28件PASS。最新main統合後は未再実行 |
| Migration / Repository / 同期ポリシー / エラー分類 | 初期実装時の既存確認を参照。最新main統合後は未再実行 |
| npm test / check | 最新main統合後は未実行。初期ベースでは既存Schedulerの5件が失敗し、同じベースのmainでも再現した |
| expo-doctor | 統合前に20/20通過。最新main統合後は未再実行 |
| ネイティブビルド | 統合前のiOS Simulator用development build成功。最新mainの追加差分はJavaScriptと文書 |
| 資格情報の静的確認 | 変更ファイル29件で代表的なtoken / secret形式の一致なし。`.env.local`はGit管理外・権限0600 |
| 他の作業の変更 | 通常のチェックアウトの未コミット変更を保持し、独立worktreeで実装 |

認証ライブラリの動的importによる読み込み失敗、iOS再起動時のセッション未復元、中断した同期を成功扱いする表示を修正しました。

## 残る確認

- 最新main取り込み後の実アカウントでの再確認。
- 実アカウントでの予定日・家事名変更と接続解除。
- 実機でのバックグラウンド実行。iOS Simulator上の未検証は実機PASSへ読み替えません。
- Android実機の認証。EAS / Google Play配布時は実際の署名鍵に対応するAndroid OAuthクライアントを登録します。

設定方法と制約は [セットアップ手順](./google-sync-setup.md) を参照してください。

## Phase 1 Closeout（Phase 2着手前）

2026-10-25、開始HEAD `e2bb58a04a4432a533d0c7c39e5f7f4d68873ade` で再確認しました。取得し直したorigin/mainは `e14e085288adab85a3df591d6c587c80f5f6e2d0` で、取り込み済みです。

- `npm test`: 125/125 PASS。
- Google同期・migrationの個別テスト: 28/28 PASS。
- `npm run lint` / `npm run typecheck` / `npm run check`: PASS。
- `npm run doctor`: 20/20 PASS。
- `git diff --check`: PASS。
- origin/mainの変更していないソースを別ディレクトリへ展開した比較実行: `npm test` 99/99 PASS。以前のScheduler 5件の失敗は今回再現していません。
- 本人の操作で接続解除・再接続を確認。解除後もGoogle上の既存Taskは残り、再接続後も同じ日のTaskは1件のままです。端末の対応表も180件、同期成功状態を確認しました。
- 予定日・家事名変更の実Google確認: NOT_EXECUTED。現在の画面には個々の予定日と家事名を直接編集する操作がなく、今回のcloseoutでは追加していません。対応するpatchロジックのテストはPASSです。
- Physical-device background: `NOT_EXECUTED_NO_PHYSICAL_DEVICE`。device inventoryにはSimulatorのみでした。clock injectionによる24時間・1時間・no-op・stale recoveryのテストはPASSです。

Closeout Gate: PASS。Phase 2へ進む条件を満たしています。[確認記録](./qa-assets/google-sync-phase2-2026-10-25/phase1-closeout.json)
