import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createV2DevelopmentPreview } from '../src/features/sharing/development/v2-preview-session.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';

async function fixture() {
  const h = createDatabase(); let id = 0; let syncs = 0;
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `workspace-screen-${++id}`, now: () => new Date(),
    openDatabase: async () => ({ database: h.database, close: async () => h.connection.close() }) });
  const active = { protocol: 2, groupId: preview.groupId, userId: preview.userId, identity: { deviceId: 'native-device' }, record: async () => ({ status: 'active' }),
    session: { controller: preview.controller }, sync: async () => { syncs++; } };
  const context = { ready: true, active, userId: preview.userId, groups: [{ groupId: preview.groupId, displayName: '選択した家族' }] };
  return { ...h, preview, context, callbacks: new Set(), synced: () => syncs };
}
async function route(f, platform, file, params = {}, readyText = '送信待ち') {
  let focus; const navigation = [];
  const screen = screenHarness(`src/app/group-v2/${file}.tsx`, { platform, params, focusEffect: (callback) => { focus = callback; }, navigate: (...args) => navigation.push(args),
    mocks: { '../../../hooks/use-workspace': { useWorkspace: () => f.context },
      '@/platform/sharing/workspaces': { sharingFailureMessage: () => '同期を確認してください。', subscribeSharingChanges: (callback) => { f.callbacks?.add(callback); return () => f.callbacks?.delete(callback); } },
      '../../../hooks/use-planner-data': { usePlannerData: () => ({ snapshot: { settings: { frequencyMode: 'balanced', restDays: [], heavyDailyLimit: 2, normalDailyLimit: 3 } } }) } } });
  const leave = focus?.(); for (let n = 0; n < 30 && !screen.text().includes(readyText); n++) await screen.flush();
  assert.ok(screen.text().includes(readyText), screen.text()); return { screen, leave, navigation };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} selected v2 workspace routes reuse authenticated forms and preserve historical round parameters`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find((item) => item.activeInPeriod); const subject = round.subjects[0];
      const params = { occurrenceId: round.id, subjectId: subject.id, anchorDate: round.anchorDate };
      for (const [file, ready] of [['calendar', '共有カレンダー'], ['history', '実施履歴'], ['requests', '日時の変更申請'], ['assignment-requests', '担当の変更申請'],
        ['round', '共通の設定を開く'], ['date', '日時の指定'], ['assignment', '担当変更の適用範囲'], ['chores', '共有家事の一覧'],
        ['add-chore', 'この内容を共有家事に追加'], ['details', '家事名・手順の編集'], ['group-rules', 'グループの種類'], ['date-rights', '日時変更の権限']]) {
        const r = await route(f, platform, file, ['details', 'date-rights'].includes(file) ? { choreId: round.choreId } : params, ready); assert.ok(r.screen.text().includes('選択した家族'));
        assert.equal(r.screen.text().includes('クラウドへ送信しません'), false); r.leave?.();
      }
      const home = await route(f, platform, 'index'); await home.screen.press('今すぐ同期'); assert.equal(f.synced(), 1);
      await home.screen.press('共有カレンダー'); assert.deepEqual(home.navigation.at(-1), ['push', '/group-v2/calendar']);
      await home.screen.press('共有家事の一覧・編集'); assert.deepEqual(home.navigation.at(-1), ['push', '/group-v2/chores']);
      await home.screen.press('グループのルール'); assert.deepEqual(home.navigation.at(-1), ['push', '/group-v2/group-rules']);
      assert.equal(home.screen.text().includes('設定を検査'), false);
      await home.screen.press('グループの管理・切り替え'); assert.deepEqual(home.navigation.at(-1), ['push', { pathname: '/sharing', params: { groupId: f.preview.groupId } }]); home.leave?.();
      const detail = await route(f, platform, 'round', params, '共通の設定を開く'); await detail.screen.press('日時を変更');
      assert.deepEqual(detail.navigation.at(-1), ['push', { pathname: '/group-v2/date', params }]); detail.leave?.();
      const editor = await route(f, platform, 'details', { choreId: round.choreId }, '日時変更の権限へ'); await editor.screen.press('日時変更の権限へ');
      assert.deepEqual(editor.navigation.at(-1), ['push', { pathname: '/group-v2/date-rights', params: { choreId: round.choreId } }]); editor.leave?.();
    } finally { f.connection.close(); }
  });
  test(`${platform} unselected or mismatched v2 workspace routes never load shared controllers or expose edit controls`, () => {
    for (const active of [null, { protocol: 1 }, { protocol: 2, userId: 'another-account' }]) {
      let focused = 0;
      const context = { ready: true, active, userId: 'owner' };
      for (const file of ['index', 'round', 'date', 'assignment', 'configuration', 'requests', 'assignment-requests', 'history', 'calendar', 'chores', 'details', 'add-chore', 'group-rules', 'date-rights']) {
        const screen = screenHarness(`src/app/group-v2/${file}.tsx`, { platform, params: {}, focusEffect: () => { focused++; }, mocks: {
          '../../../hooks/use-workspace': { useWorkspace: () => context }, '../../../hooks/use-planner-data': { usePlannerData: () => ({}) } } });
        assert.match(screen.text(), /共有グループを選択/u); assert.equal(screen.nodes().some((node) => node.type === 'TextInput'), false);
      }
      assert.equal(focused, 0);
    }
  });
  test(`${platform} an unconfigured shared chore stays disabled until explicit valid initial settings and then enters the autosave editor`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const chore = model.plan.chores.find((item) => item.name === 'トイレを掃除する');
      const r = await route(f, platform, 'configuration', { choreId: chore.id }, '家事の種類と周期を設定'); const before = (await listSharingOutbox(f.database, f.preview.groupId)).length;
      await r.screen.press('この条件で家事を有効にする'); assert.match(r.screen.text(), /種類を選んで/u);
      assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before);
      const preset = r.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === 'メンバーごとに行う');
      assert.ok(preset); preset.props.onPress(); await r.screen.flush();
      await r.screen.change('初回の周期', '0'); await r.screen.press('この条件で家事を有効にする');
      assert.match(r.screen.text(), /周期は1/u); assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before);
      await r.screen.change('初回の周期', '7'); await r.screen.press('この条件で家事を有効にする');
      assert.match(r.screen.text(), /変更は自動で保存/u);
      const configured = (await f.preview.readModel()).configurations.find((item) => item.choreId === chore.id).configuration;
      assert.equal(configured.active, true); assert.equal(configured.intervalDays, 7); assert.equal(configured.policy.completion, 'perMember');
      assert.deepEqual(configured.targetMemberIds, [f.preview.userId]); assert.equal((await listSharingOutbox(f.database, f.preview.groupId)).length, before + 2); r.leave?.();
    } finally { f.connection.close(); }
  });
  test(`${platform} an initial shared chore can start on a future anchor without invalidating its effective date or creating past work`, async () => {
    const f = await fixture();
    try {
      const model = await f.preview.readModel(); const chore = model.plan.chores.find((item) => item.name === 'トイレを掃除する'); const future = addDays(model.plan.range.asOfDate, 7);
      const r = await route(f, platform, 'configuration', { choreId: chore.id }, '家事の種類と周期を設定');
      const preset = r.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '誰か1人が行う');
      preset.props.onPress(); await r.screen.flush(); await r.screen.change('共有家事の基準日', future); await r.screen.change('初回の周期', '7');
      await r.screen.press('この条件で家事を有効にする'); const next = await f.preview.readModel();
      const configuration = next.configurations.find((item) => item.choreId === chore.id).configuration;
      assert.ok(configuration, r.screen.text()); assert.equal(configuration.anchorDate, future); assert.equal(configuration.effectiveFrom, future);
      assert.ok(next.plan.occurrences.filter((round) => round.choreId === chore.id).every((round) => round.anchorDate >= future));
      assert.equal(next.plan.history.some((record) => record.choreId === chore.id), false); r.leave?.();
    } finally { f.connection.close(); }
  });

  test(`${platform} normal shared creation replaces the add screen and opens its new disabled chore in the same workspace`, async () => {
    const f = await fixture();
    try {
      const r = await route(f, platform, 'add-chore', {}, 'この内容を共有家事に追加');
      await r.screen.change('追加する共有家事の名前', '通常導線で追加した家事'); await r.screen.press('この内容を共有家事に追加');
      for (let n = 0; n < 25 && !r.navigation.length; n++) await r.screen.flush();
      const chore = (await f.preview.readModel()).plan.chores.find((item) => item.name === '通常導線で追加した家事'); assert.ok(chore); assert.equal(chore.enabled, false);
      assert.deepEqual(r.navigation.at(-1), ['replace', { pathname: '/group-v2/details', params: { choreId: chore.id } }]); r.leave?.();
    } finally { f.connection.close(); }
  });
  test(`${platform} foreground shared changes refresh only the selected user and group and unsubscribe when leaving`, async () => {
    const f = await fixture();
    try {
      const r = await route(f, platform, 'index'); const model = await f.preview.readModel();
      const chore = model.plan.chores.find((item) => item.name === 'フローリングを掃除する');
      assert.equal(f.callbacks.size, 1);
      await f.preview.controller.actions.patchChore(chore.id, { name: '別端末から届いた床掃除' });
      for (const callback of f.callbacks) callback({ userId: 'another-user', groupId: f.preview.groupId });
      await new Promise((resolve) => setTimeout(resolve, 120)); await r.screen.flush(); assert.equal(r.screen.text().includes('別端末から届いた床掃除'), false);
      for (const callback of f.callbacks) callback({ userId: f.preview.userId, groupId: f.preview.groupId });
      await new Promise((resolve) => setTimeout(resolve, 120)); await r.screen.flush(); assert.ok(r.screen.text().includes('別端末から届いた床掃除'));
      r.leave?.(); assert.equal(f.callbacks.size, 0);
    } finally { f.connection.close(); }
  });
}

test('workspace navigation permits legacy screens only for personal or v1 scopes and redirects v2 to its dedicated stack', () => {
  for (const active of [null, { protocol: 1 }, { protocol: 2 }]) {
    const guards = []; const Stack = ({ children }) => children; Stack.Screen = 'StackScreen';
    Stack.Protected = ({ guard, redirectTo, children }) => { guards.push({ guard, redirectTo }); return guard ? children : null; };
    const screen = screenHarness('src/components/workspace-navigator.tsx', { exportName: 'WorkspaceNavigator', mocks: {
      'expo-router': { Stack }, '../hooks/use-workspace': { useWorkspace: () => ({ active }) } } });
    const names = screen.nodes().filter((node) => node.type === 'StackScreen').map((node) => node.props.name);
    assert.ok(names.includes('sharing')); assert.ok(names.includes('help'));
    assert.equal(names.includes('group-v2'), active?.protocol === 2); assert.equal(names.includes('(tabs)'), active?.protocol !== 2);
    assert.deepEqual(guards.map((guard) => guard.redirectTo), ['/group-v2', '/sharing']);
  }
});
