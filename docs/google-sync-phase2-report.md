# Google Tasks Phase 1 Closeout / Phase 2 実装・確認結果

確認日: 2026-10-25（Asia/Tokyo）

## 作業元とコミット

| 項目 | 値 |
| --- | --- |
| START_SHA | `e2bb58a04a4432a533d0c7c39e5f7f4d68873ade` |
| ORIGIN_MAIN_SHA | `e14e085288adab85a3df591d6c587c80f5f6e2d0`（着手時にfetchして確認） |
| PHASE1_START_COMMIT | `1feb38084837c166347b7cdbfc01785daba5dfc5` |
| Phase 1 closeout | `b105675d501a9d8ed5dcfb6915731b1f5f670e44` |
| Phase 2 実装 | `8123046ac4c9ea13d43b79dc00a0c6b17ad6899e` |
| Branch | `codex/google-tasks-sync-phase2` |
| Worktree | `/Users/hiroki/.codex/worktrees/google-tasks-sync-phase1/ハッカソン` |

最終HEADは実装コミットに本レポート・確認記録を加えたコミットです。自己参照を避けるため、その厳密なFINAL_SHAは完了回答に記載しています。下記コマンドはレポートを含む最終HEADでも再実行して確認しました。

既存の専用worktreeを継続利用しました。主作業ディレクトリには他作業の未コミット変更があるため、mainへの反映は行っていません。pushは行っていません。

## Phase 1 Closeout

Phase 2着手前に最新mainを含むSTART_SHAでゲートを確認しました。

| 項目 | 結果 |
| --- | --- |
| Google同期・migration個別テスト | PASS: 28/28 |
| `npm test` | PASS: 125/125 |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run check` | PASS |
| `npm run doctor` | PASS: 20/20 |
| `git diff --check` | PASS |
| origin/main単体の`npm test` | PASS: 99/99 |
| Due-date live patch | NOT_EXECUTED_NO_DIRECT_EDITOR |
| Title live patch | NOT_EXECUTED_NO_DIRECT_EDITOR |
| Disconnect/reconnect | PASS: 本人操作と端末記録で確認 |
| Physical-device background | NOT_EXECUTED_NO_PHYSICAL_DEVICE |
| Closeout Gate | **PASS** |

origin/main単体は、上記SHAのソースを`git archive`で展開し、同じインストール済みnode_modulesを参照して比較しました。過去のScheduler 5件のfailureは、今回のmain単体・Google branchとも再現しませんでした。新しいfailureを既存failureとして除外していません。

本人の操作で、接続解除後もGoogle上の家事が残り、再接続でき、同日のTaskが増えないことを確認しました。端末の対応表も180件、同期成功状態でした。予定日・家事名を直接編集する現在の画面がないため、その実Google操作は未実施です。対応する差分patchはテストで確認しています。

利用可能なデバイスはSimulatorのみでした。物理端末のBackgroundTaskをPASSとは扱っていません。24時間通常同期・約1時間retry・同期不要時API call 0・foreground復帰の再判定はclock injection / unit testでPASSです。

[Phase 1確認記録](./qa-assets/google-sync-phase2-2026-10-25/phase1-closeout.json)

## Phase 2の実装

### 取得と同期順序

専用Task Listの`tasks.list`を`maxResults=100`で全ページ取得します。各ページに`showCompleted=true`、`showHidden=true`、`showDeleted=true`を指定します。`nextPageToken`を最後までたどり、同じtokenの繰り返しはエラーにします。`updatedMin`やCalendarの`syncToken`は使用していません。

同期順序は、全ページ取得 → 対応表のあるGoogle完了を取り込み → 既存Schedulerの結果を再読込 → Planner側完了とtitle/due差分を送信 → obsolete cleanup → 成功状態保存、です。リモート完了を読む前に未完了へ戻す処理はありません。

[Google公式の取得条件](https://developers.google.com/workspace/tasks/reference/rest/v1/tasks/list)に従い、Googleの画面で完了してhiddenになったTaskも取得します。取得済みのTask一覧を照合に使い、180件それぞれのGETを送らない構成です。

### 既存完了処理・Schedulerへの合流

- `ChoreCompletion.source`に`googleTasks`を追加しました。既存source列はTEXTのため、schemaはv14を維持しています。
- アプリ・Widget・Google取り込みは共通の完了保存処理を使います。Google専用の履歴テーブルやSchedulerはありません。
- Google Task IDとTask List IDの保存済み対応表を検証し、schedule entry / choreへ解決します。名前一致での関連付けはありません。
- `completed`の明示的なRFC3339時刻を同じ瞬間のUTC ISOへ正規化して保存します。欠落・不正な日時は取り込まず、診断件数を記録します。`updated`・due・現在時刻で代用しません。
- 保存済みschedule entryから予定日・windowを保持します。entryが既に整理済みの場合は対応表の予定日を使い、失われたwindowは捏造しません。Google由来履歴の`estimatedDate`はfalseです。
- 複数候補のmappingとschedule情報を先に確保し、時刻順に1トランザクションで保存してから通常のPlanner snapshot生成を呼びます。古い完了で新しいChoreStateを巻き戻しません。
- 同じschedule entryに既存履歴があれば取り込みはno-opです。既存のアプリ・Widget由来sourceと時刻も変えません。ローカルで取り消した履歴行がある場合も、その行をGoogle取り込みで再作成・再完了しません。
- 保存後、通常の通知・Widget更新を実行し、表示中のホーム・カレンダー・履歴を再読込します。background処理は画面関数を呼びません。履歴画面にはGoogle Tasks由来を表示します。

### 取消・削除・失敗時

Googleで未完了へ戻してもPlannerの完了履歴・家事状態・次回予定は戻しません。Plannerに完了が残る場合は既存の送信方向によってGoogleも再び完了になります。

Google側削除で家事定義や取り込み済み履歴を消しません。削除された完了済み履歴Taskを再作成せず、有効な未完了予定だけPhase 1のルールで再作成します。対応表のない手動追加Taskは無視します。

pull失敗も既存の分類へ合流させています。network / timeout / 5xxはretry、429はRetry-After優先、認証失効はauthRequired、恒久4xxはerrorです。通常24時間・一時失敗時約1時間の間隔と手動同期・中断復帰を維持しています。

## Phase 1 + Phase 2 統合テスト

| 項目 | 結果・確認方法 |
| --- | --- |
| tasks.list pagination | PASS: 100+80件、180番目の完了を取り込み |
| showCompleted=true | YES: HTTPリクエストをassert |
| showHidden=true | YES: HTTPリクエストをassert、hidden完了を取り込み |
| Remote completed → ChoreCompletion | PASS: 実SQLiteとの統合テスト、実アカウント |
| Google completed timestamp used | PASS: 正規化・不正日時skip・実DB時刻 |
| Duplicate prevention | PASS: 再同期・並行取り込み・実アカウント |
| Already-local-completed | PASS: 履歴・source・時刻を維持 |
| Unknown Task ignored | PASS: 同名の未対応Taskも無視 |
| Remote uncomplete does not undo local | PASS: 統合テスト、実アカウント |
| Remote deletion does not delete history | PASS: 統合テスト |
| Multiple completion import | PASS: 同一家事3件の一括取り込み、実アカウント2件 |
| ChoreState update | PASS: 時刻から通常の最終完了日を更新 |
| Scheduler next occurrence | PASS: 既存周期計算、実DBの次回予定 |
| Restart persistence | PASS: SQLite close/reopen、本人の完全終了・再起動 |
| Phase 1 create / idempotence / title・due patch / completion / cleanup | PASS |
| Retry / Retry-After / auth / interrupted manual sync | PASS |
| 途中ページ失敗・transaction失敗 | PASS: 部分取り込みを残さない |

主要な追加テストは`tests/google-sync-phase2.test.mjs`と`tests/google-completion-policy.test.mjs`です。API・reconciliation・coordinatorの既存テストも拡張しました。

### 最終コマンド

| コマンド | 結果 |
| --- | --- |
| `npm test` | PASS: **145/145** |
| `node --disable-warning=MODULE_TYPELESS_PACKAGE_JSON --experimental-strip-types --test tests/google-*.test.mjs tests/storage-migrations.test.mjs` | PASS: **48/48** |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run check` | PASS: lint / typecheck / 145 tests |
| `npm run doctor` | PASS: **20/20** |
| `git diff --check` | PASS |

実装コミットで全コマンドを確認し、文書追加後の最終HEADでも同じコマンドを再実行しました。最終HEADでの実行SHA・終了コードは完了回答とローカルの検証ログに記録しています。

## Live Phase 2 E2E

**PASS**。専用iOS Simulatorのdevelopment buildと実Googleアカウントを使い、Google Calendar / アプリの操作は本人が行いました。OAuthの再設定・APIによる完了の代行は行っていません。端末SQLiteの確認は読み取り専用です。

対象は2026-10-28の「食器を洗う」です。事前の履歴は全体2件、Google由来0件、対象予定の履歴0件でした。

| ステップ | 結果 |
| --- | --- |
| Google Calendarで対象を完了、Planner手動同期 | 本人がアプリ側も完了になったと確認 |
| 履歴 | 対象は1件だけ。source=`googleTasks`、outcome=`completed` |
| 完了時刻 | `2026-10-25T04:31:24.272Z`（13:31:24.272 JST）を保存 |
| schedule情報 | scheduledDate / windowStart / windowEndすべて`2026-10-28` |
| ChoreState | lastCompletedDate=`2026-10-25`、estimated=0、initialPending=0 |
| 次の未完了予定 | `2026-10-29` |
| Google Task ID | 取り込み前後・再同期・再起動・Google取消後も同じSHA-256で一致 |
| 再同期 | imported=0、対象履歴1件のまま |
| 完全終了・再起動 | 本人が完了の保持を確認。端末DBでも履歴・状態・次回予定が一致 |
| Googleで未完了へ変更して再同期 | 本人がPlannerの完了保持を確認。DBも履歴・元の完了時刻・状態・次回予定を維持 |

初回pullでは、以前Google側で完了していた2026-10-30の別予定も取り込みました。全体履歴は2→4件、Google由来は0→2件となりました。10月28日・30日はそれぞれ異なる予定で、対象日の重複ではありません。繰り返し同期・再起動・Google側取消後も全体4件、Google由来2件、10月28日は1件です。

### API件数・所要時間

開発時ログには件数と所要時間のみを出し、token・header・Task IDは出していません。

| サンプル | 取得Task | hidden完了 | 新規取り込み | read API | write API | 所要時間 |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| 初回pull | 180 | 2 | 2 | 3 | 0 | 9,857 ms |
| 差分なし再同期 | 180 | 2 | 0 | 3 | 0 | 1,119 ms |
| Google取消後の同期サンプル1 | 180 | 1 | 0 | 3 | 1 | 2,784 ms |
| Google取消後の同期サンプル2 | 180 | 1 | 0 | 3 | 1 | 1,659 ms |

read 3件はTask List取得1回とTask取得2ページです。初回には開発バンドルの初回ロード等も含まれるため、9,857 msをAPIだけの所要時間とは扱いません。差分なし再同期は全ページを読んで書き込み0件でした。取消後はPlannerの完了をGoogleへ送る書き込みが発生します。

[Phase 2確認記録](./qa-assets/google-sync-phase2-2026-10-25/phase2-verification.json)

## 資格情報・対象範囲

Google native SDKによる認証、`offlineAccess=false`、Tasks scope、backendなしを維持しています。token自前保存・client secret埋め込み・Calendar scope追加はありません。

変更された追跡ファイルに対する既知のtoken / secret / private key / credential JSONのリテラルパターン検査で該当0件でした。`.env.local`はGit管理外・0600です。ログは件数と分類コードだけで、認証headerやtokenの値を記録しません。この検査は指定パターンの検査であり、任意の資格情報を検出する保証ではありません。

Calendar FreeBusy・独自Scheduler・horizon変更は行っていません。180件は異なる予定への正規の対応表として維持しています。

## 残る未確認事項

- 物理iOS / Android端末でOSが実際に起動するBackgroundTask: **NOT_EXECUTED_NO_PHYSICAL_DEVICE**。Simulatorとmock clockの結果で代用していません。
- 名前・予定日変更の実Google patch: **NOT_EXECUTED_NO_DIRECT_EDITOR**。差分patchの統合テストはPASSです。
- Android実アカウント認証・配布署名による認証: 今回のlive E2E対象外です。

Phase 1ゲートとPhase 2の実装・必須テスト・実アカウントの完了往復・再同期・再起動は完了しています。
