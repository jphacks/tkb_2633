# Google Calendar FreeBusy / Phase 3 実装・確認結果

確認日: 2026-10-25（Asia/Tokyo）

## 作業元とコミット

| 項目 | 値 |
| --- | --- |
| START_SHA | `42479dbf9bfc343cffceb4b7368f8bf96dafebd4` |
| ORIGIN_MAIN_SHA | `e14e085288adab85a3df591d6c587c80f5f6e2d0`（着手時にfetchして確認） |
| PHASE2_BASE_SHA | `42479dbf9bfc343cffceb4b7368f8bf96dafebd4` |
| LATEST_INTEGRATED_MAIN_SHA | `31fdf35125166416f476f7e3f9bcfe7a982a1316`（終了前に再fetchして確認・統合） |
| Phase 3実装 | `b0065221f4bdd6b2d3a79aec7ef728d94d85e95d` |
| セットアップ・構成文書 | `2592d5c` |
| 最新mainの統合 | `eb0673846c56bd0da8ab22a259cc657c21b0ee34` |
| FINAL_SHA | 本レポートを含む最終HEAD。自己参照を避け、厳密なSHAは完了回答に記載。`git rev-parse codex/google-calendar-phase3`で取得可能 |
| Branch | `codex/google-calendar-phase3` |
| Worktree | `/Users/hiroki/.codex/worktrees/google-tasks-sync-phase1/ハッカソン` |

Phase 2を祖先に持つ専用worktreeで作業しました。作業中にmainへ追加された完了件数・家事本文の更新も統合しました。主作業フォルダには他作業の変更があるため、主作業フォルダやmainへの反映は行っていません。pushは行っていません。

## OAuth / Privacy

| 項目 | 結果 |
| --- | --- |
| Tasks scope | `https://www.googleapis.com/auth/tasks` |
| Calendar scope | `https://www.googleapis.com/auth/calendar.freebusy` |
| Incremental auth | PASS: 設定ON／再許可操作からのみ追加要求。拒否してもTasks状態は維持 |
| Broad Calendar scope added | NO |
| Primary calendar only | YES: `items: [{ id: 'primary' }]` |
| Event metadata requested | NO: Events / CalendarList APIを実装・使用しない |
| Raw busy intervals persisted | NO: メモリ内で集計後に破棄 |
| Credential leak | PASS: 変更ファイルの資格情報リテラル検査0件。`.env.local`はGit管理外・0600 |

既存のGoogle native SDK、`react-native-nitro-google-signin`、`offlineAccess=false`、backendなしを維持しました。client secretやrefresh tokenの自前保存は追加していません。Calendar用APIキーも不要です。

初回Tasks接続で要求するサービスscopeはTasksのみです。CalendarのON操作は`AppState`がactiveの場合に限定します。自動処理のtoken取得には`requestScopes`・対話ログインへのfallbackがありません。

Android SDK 2.3.0の`getTokens()`は内部で追加許可UIを解決できるため、`postinstall`のパッチで自動取得時のresolutionを禁止しました。追加scopeだけが対話を必要とする場合は基本scopeのサイレント取得を試み、成功時は保存scopeを更新します。Calendar getterは更新後のscopeも再確認します。パッチの適用対象・再適用の冪等性・対話操作の維持をソースに対して検査しています。**Androidネイティブのコンパイル・実アカウント動作は未検証で、新しいdevelopment buildが必要です。**

## FreeBusy

| 項目 | 結果 |
| --- | --- |
| Live FreeBusy | PASS: 専用iOS Simulatorのdevelopment build＋実Googleアカウント |
| timeZone | `Asia/Tokyo`（端末のIntlから取得。固定offsetなし） |
| Query range | `2026-10-25`〜`2027-04-23`、今日から180日先までの181日分 |
| timeMin | `2026-10-24T15:00:00.000Z`（from日の現地00:00） |
| timeMax | `2027-04-23T15:00:00.000Z`（through翌日の現地00:00、end-exclusive） |
| Overlap merge | PASS: 重複・包含・隣接をまとめてから分数を計算 |
| Cross-day split | PASS: 現地日付境界で分割・query外をclip |
| DST | PASS: America/New_Yorkの23時間・25時間の日を検査 |
| All-day | PASS: 通常日1440分、DST日は実経過分数 |
| Calendar API calls per refresh | **3 POST / 181日**。Events APIは0件 |
| 取得時間の実測 | 971ms、942ms、2681ms（3 POST全体） |

### HTTP要求の分割

実Googleで181日を1 POSTにするとHTTP 400（`calendar_time_range_too_long`）になりました。Schedulerのhorizonを保つため、通信だけを最大90×24時間ずつの連続区間に分けています。この90日は実動確認に基づく実装上の上限であり、公式資料の明記値として扱っていません。

全区間の成功後に重複merge・日別集計を行い、181日すべてのaggregateと成功状態を1 transactionで置換します。途中区間の失敗時に一部の日だけを新しくしません。範囲は既存Plannerの`plannerGenerationRange(today)`を共有し、既存180 TasksやSchedulerの期間は削減していません。

実Googleでは181日のうち47日がbusyでした。例: 11月23日は90分、11月24日は270分です。Calendarの予定タイトル・場所・参加者などは取得・記録していません。

## Cache / Retry

| 項目 | 結果 |
| --- | --- |
| Schema version | **15**。v14から連番migrationを追加 |
| 保存するCalendar情報 | `local_date` / `busy_minutes` / `time_zone` / `fetched_at`と世帯キー |
| Calendar状態 | Tasksとは別テーブル。enabled / last success / retry / permission / error |
| Freshness | 最大36時間。現在と異なるtimezone・未来の取得日時・stale情報を除外 |
| 24h refresh | PASS: 時計を注入したテスト |
| 1h retry | PASS: network / timeout / 5xx / native処理不可 |
| 429 / rate limit | PASS: `Retry-After`と最小1時間を尊重。403のrate limitも同様 |
| scope不足 | Calendarのみ`permissionRequired`。foreground UIから再許可 |
| API無効 / 恒久4xx | Calendarのみerror。Tasksは継続 |
| Tasks sync independent from Calendar failure | PASS: 各障害下でTasks成功・Google完了取込まで検査 |
| Calendar disabled → 0 requests | PASS: client呼出0件。実操作OFF後もcache0・Tasks利用継続 |
| cache更新のatomicity | PASS: 途中書込失敗で日別cache・成功状態の両方をrollback |
| fresh DB / v14→15 / 二重migration | PASS |
| mapping・Phase 2履歴保持 / FK / index / CRUD | PASS |

既存BackgroundTask・前面復帰・手動同期から同じGoogle操作キューを使います。Calendar設定の変更も同じキューに入り、二重取得やOFF中の古い取得結果のcommitを防ぎます。Calendar失敗時は36時間以内のcacheだけを利用し、期限切れならCalendarなしで通常のPlannerを生成します。

OFF操作はcacheを消去し、Calendar penaltyなしで再生成してからPhase 1でdue差分を送信します。アカウント接続やTasks同期は維持します。現UIではTasks自動同期が有効な間にCalendarをONにする構成です。

## Scheduler

| 項目 | 結果 |
| --- | --- |
| No-Calendar regression | PASS: undefined / empty / 全0分で全予定が同一 |
| busy bucket | 0〜120 / 121〜300 / 301〜480 / 481分以上 |
| shift equivalent | light=1、normal=2、heavy=3 |
| score | `[capacityOverflow, restPenalty, abs(offset)+bucket×equivalent, load.total, distance]` |
| Heavy avoids busy | PASS: unit test・実Googleで11/24→11/23 |
| Light stays nearer | PASS: 負荷別の比較テスト |
| maxShift / window / cycle / load limits | PASS |
| restDays / holidayPriority | PASS |
| dependencies / overdue | PASS |
| weather regression | PASS: Calendarが雨の日を好んでも屋外洗濯の天気条件を維持。取得失敗fallbackも維持 |

Calendarは候補除外条件にしていません。全候補がbusyでも家事は残ります。日付変更後もcycle基準のschedule entry IDを維持し、同じGoogle Taskのdueだけを更新します。

### 最新mainの完了ルールとの統合

最新main `31fdf35`は、実施期間前に未来の予定を完了しても今日の周期を進めず、推奨日が来てから反映する変更を含みます。共有の完了保存処理にもこの条件を統合し、Googleから取り込んだ実際の完了時刻・予定日・window・履歴を保持しました。過去の完了で新しい状態を巻き戻さないPhase 2の条件も維持しています。

旧テストで未来の予定を今日の完了として周期変更していたfixture 3か所を、元の検査目的に合わせて実施期間開始済みの予定へ変更しました。別途、未来のGoogle完了が今日の周期を進めず、推奨日以降に次周期へ反映されるテストを追加しました。最新main単体も隔離したソースで99/99 testsを実行して比較しています。

## Google Tasks regression

| 項目 | 結果 |
| --- | --- |
| Phase 1 | PASS: create / idempotence / title・due差分 / completion / cleanup |
| Phase 2 | PASS: 全ページ・showCompleted / showHidden、取込・再起動・取消／削除で履歴保持 |
| Duplicate prevention | PASS: unit / integration / 実Google再同期・再起動 |
| Task ID preserved after Calendar reschedule | PASS: 実Googleの前後でSHA-256照合 |
| Due patch | PASS: 実Googleで同じTaskが11/24→11/23。統合テストでPATCH本文はdueだけ |
| 原来の180 Tasks | PASS: 終了時も180件。Phase 2確認対象のTask IDも前回と一致 |

## Live Phase 3 E2E

**PASS（iOS Simulator＋実Google）**。Google Calendar APIの有効化を復旧した後、Calendar ON→FreeBusy→予定日変更→同じTaskの更新→Google側で完了→Planner取込→再同期・完全終了／再起動を確認しました。

アプリ・Googleでの最終操作は本人が行い、端末SQLiteは読み取り専用で照合しました。他のDevice Hub端末は閉じていません。実Googleの一連の操作はmain統合前の同期実装で行い、統合後には同じ端末DBのcache・履歴・ID・180件の保持と、202件の自動テストを再確認しました。統合後のカタログversionも2になっています。

| 手順 | 結果 |
| --- | --- |
| Calendar OFF / 確認用heavy家事を初回完了 | 30日周期の次回基準日11/24を作成 |
| Calendar ON / FreeBusy取得 | 11/24=270分、11/23=90分 |
| Scheduler | 基準IDを保ち、推奨日11/24→11/23 |
| Google Tasks | 同じID、lastSyncedDueDate=11/23。Calendarによる再作成なし |
| Google側で11/23のTaskを完了 | `2026-10-25T08:11:04.616Z`の完了を取り込み |
| Planner履歴 | source=`googleTasks`、scheduledDate/window=`2026-11-23`、1件だけ |
| 次回 | Calendar cacheを使う通常のPlanner再生成。次の未完了は12/24（busy0分） |
| 再同期・完全終了／再起動 | Calendar ON・cache181日・認証・履歴を保持。対象履歴は1件のまま |
| 確認用家事の後片付け | disabled、幅±2日、休日優先ONへ復元。未完了の確認用Task5件を通常cleanup |
| 最終状態 | Tasks / Calendarともidle、retry0、errorなし。Calendar ON・cache181日 |

Task IDは生値を記録せず、[確認用JSON](./qa-assets/google-sync-phase3-2026-10-25/verification.json)にfingerprintを保存しました。確認で追加した完了履歴2件（アプリ1件・Google1件）と完了済みGoogle Task1件は通常の履歴保持ルールに従って残っています。元からの履歴4件・Task180件は残しています。

実測例: 日付変更時のTasks処理は2337ms・GET 3回・write 1回、完了取込時は2113ms・GET 3回・write 0回・imported 1件でした。GETにはリストの照合とTask全ページを含みます。ログは件数・時間・状態・取得範囲だけです。

Calendar許可の実アカウント拒否は再現していません。拒否時のTasks継続、再要求、backgroundで対話しない条件はテスト・コード経路で確認しています。

## Quality

下記コマンドは本レポートを含む最終HEADでも実行します。最終SHA・終了コードは完了回答とローカルの最終HEAD receiptに記録します。

| コマンド・項目 | 結果 |
| --- | --- |
| `npm test` | PASS: **202/202** |
| Google tests（`tests/google-*.test.mjs`＋migration） | PASS: **105/105** |
| Phase 3 tests（`tests/google-calendar-*.test.mjs`） | PASS: **56/56** |
| `npm run lint` | PASS |
| `npm run typecheck` | PASS |
| `npm run check` | PASS: lint / typecheck / 202 tests |
| `npm run doctor` | PASS: **20/20** |
| `git diff --check` | PASS |
| Live Phase 3 E2E | PASS: 上記の検証時点・範囲を参照 |
| Physical-device background | NOT_EXECUTED_NO_PHYSICAL_DEVICE |
| Android native compile / real-account run | NOT_EXECUTED |
| Other user changes preserved | YES: 専用worktreeだけを編集 |
| Push | **NO** |

## 残項目

- Androidはpostinstallのネイティブパッチを含むdevelopment buildを作り、追加許可・自動token取得・実アカウント同期を確認する必要があります。
- 物理端末のBackgroundTask実動は未検証です。OSによる遅延・実行可否と非対話token取得の制限は残ります。
- 主作業フォルダの他作業変更は統合していません。今回の成果は上記ブランチに保存しており、pushしていません。

## 参照

- [Google FreeBusy query](https://developers.google.com/workspace/calendar/api/v3/reference/freebusy/query)
- [Google Calendar OAuth scopes](https://developers.google.com/workspace/calendar/api/auth)
- [Google OAuth incremental authorization](https://developers.google.com/identity/protocols/oauth2)
- [Google Calendar error handling](https://developers.google.com/workspace/calendar/api/guides/errors)
- [Google iOS API access](https://developers.google.com/identity/sign-in/ios/api-access)
- [Android authorization](https://developer.android.com/identity/authorization)
- [セットアップ](./google-sync-setup.md) / [Phase 2結果](./google-sync-phase2-report.md)
