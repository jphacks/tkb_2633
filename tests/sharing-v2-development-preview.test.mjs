import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createV2DevelopmentPreview } from '../src/features/sharing/development/v2-preview-session.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

const screenFile = 'src/features/sharing/development/v2-preview-screen.tsx';
async function screenFixture(platform, view = 'home', clock = () => new Date('2026-10-27T01:00:00Z')) {
  const h = createDatabase(); let id = 0;
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `screen-${++id}`, now: clock,
    openDatabase: async () => ({ database: h.database, close: async () => h.connection.close() }) });
  let focus; const navigation = []; const props = { development: true, loadSession: async () => preview, view,
    onBack: () => navigation.push(['back']), onConfiguration: (choreId) => navigation.push(['configuration', choreId]), onHistory: () => navigation.push(['history']),
    onDate: (occurrenceId, subjectId) => navigation.push(['date', occurrenceId, subjectId]),
    onRound: (occurrenceId, subjectId) => navigation.push(['round', occurrenceId, subjectId]) };
  const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props, platform, focusEffect: (callback) => { focus = callback; } });
  const leave = focus();
  for (let i = 0; i < 30 && !screen.text().includes('検査用の未送信操作'); i++) await screen.flush();
  return { preview, props, screen, navigation, leave, focus: () => focus() };
}

test('v2 development fixture refuses release execution before opening storage, creating identities or accessing an account', async () => {
  let calls = 0;
  await assert.rejects(createV2DevelopmentPreview({ development: false, makeId: () => { calls++; return 'unused'; }, now: () => new Date(),
    crypto: { randomBytes: () => { calls++; throw new Error('Unexpected crypto'); } }, openDatabase: () => { calls++; throw new Error('Unexpected DB'); } }));
  assert.equal(calls, 0);
});

test('v2 development fixture uses a fresh synthetic scope and real signed SQLite operations without cloud receipts or a personal database', async () => {
  let id = 0; let opened; const h = createDatabase();
  const preview = await createV2DevelopmentPreview({ development: true, crypto, makeId: () => `preview-${++id}`, now: () => new Date('2026-10-27T01:00:00Z'),
    openDatabase: async (userId, groupId) => { opened = { userId, groupId }; return { database: h.database, close: async () => h.connection.close() }; } });
  try {
    assert.ok(opened.userId.startsWith('qa-v2-owner-')); assert.ok(opened.groupId.startsWith('qa-v2-')); assert.notEqual(opened.userId, 'owner');
    let model = await preview.readModel(); assert.equal(model.plan.chores.length, 20); assert.equal(model.plan.chores.filter((chore) => chore.enabled).length, 3);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM sharing_v2_server_receipts').get().n, 0);
    const round = model.plan.occurrences.find((entry) => entry.anchorDate === model.plan.range.asOfDate && entry.configuration.policy.completion === 'one');
    const ref = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: null };
    await preview.controller.actions.claim(ref); await preview.controller.actions.complete(ref); model = await preview.readModel();
    assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, true); assert.equal(model.plan.history.length, 1);
    await assert.rejects(preview.controller.sync(), /クラウドへ送信しません/);
    assert.ok(h.connection.prepare('SELECT count(*) AS n FROM sharing_outbox').get().n > 0);
    assert.equal(h.connection.prepare('SELECT count(*) AS n FROM google_sync_state').get().n, 0);
  } finally { await preview.close(); }
});

test('v2 development screen does not initialize a session or install a focus handler in a release build', async () => {
  let loaded = 0; let focused = 0;
  const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props: { development: false, loadSession: () => { loaded++; throw new Error('Unexpected'); } },
    focusEffect: () => focused++ });
  assert.ok(screen.text().includes('開発ビルド専用')); assert.equal(loaded, 0); assert.equal(focused, 0);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 isolated round navigation records explicit past work in its original group and history instead of routing the ID into a personal chore`, async () => {
    const f = await screenFixture(platform);
    try {
      await f.screen.press('フローリングを掃除する全員共通 · 担当未確定'); const [kind, occurrenceId, subjectId] = f.navigation.pop(); assert.equal(kind, 'round');
      Object.assign(f.props, { view: 'round', occurrenceId, subjectId }); f.screen.render();
      assert.ok(f.screen.text().includes('実施を記録'));
      const choice = f.screen.nodes().find((node) => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '以前実施した'); choice.props.onPress(); await f.screen.flush();
      await f.screen.change('実施日', '2026-10-27'); await f.screen.change('実施時刻', '08:00'); await f.screen.press('実施を記録する');
      const model = await f.preview.readModel(); assert.equal(model.plan.history.length, 1); assert.equal(model.plan.history[0].performedAt, '2026-10-26T23:00:00.000Z');
      assert.equal(model.plan.history[0].recordedAt, '2026-10-27T01:00:00.000Z');
      f.props.view = 'history'; f.screen.render(); assert.ok(f.screen.text().includes('実施者：検査ユーザー')); assert.ok(f.screen.text().includes('登録者：検査ユーザー'));
      await f.screen.press('この完了を取り消す'); assert.equal((await f.preview.readModel()).plan.history[0].active, false);
      Object.assign(f.props, { view: 'round', subjectId: 'another-group-round' }); f.screen.render();
      assert.ok(f.screen.text().includes('対象の家事回を表示できません')); assert.equal(f.screen.nodes().some((node) => node.type === 'TextInput'), false);
    } finally { f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 preview keeps an unfinished common round visible on its personal recommended day after midnight without writing a different common anchor`, async () => {
    let instant = new Date('2026-10-27T14:59:00Z'); const f = await screenFixture(platform, 'home', () => instant);
    try {
      const before = await f.preview.readModel(); instant = new Date('2026-10-27T15:01:00Z');
      f.leave(); const leave = f.focus();
      for (let i = 0; i < 25 && !f.screen.text().includes('10月28日'); i++) await f.screen.flush();
      const after = await f.preview.readModel(); const floor = after.plan.chores.find((entry) => entry.name === 'フローリングを掃除する');
      const round = after.plan.occurrences.find((entry) => entry.choreId === floor.id && entry.anchorDate === '2026-10-27');
      assert.equal(round.subjects[0].suggestedDate, '2026-10-27');
      assert.equal(after.personal.recommendations.find((entry) => entry.occurrenceId === round.id).date, '2026-10-28');
      assert.ok(f.screen.text().includes('フローリングを掃除する')); assert.ok(f.screen.text().includes('推奨日：10月28日'));
      assert.equal(after.pendingChanges, before.pendingChanges); leave();
    } finally { f.leave(); await f.preview.close(); }
  });
  test(`${platform} v2 isolated native preview connects home, collapsed expired rounds, configuration navigation and targeted history undo to actual SQLite`, async () => {
    const f = await screenFixture(platform);
    try {
      assert.ok(f.screen.text().includes('今日の共有家事')); assert.ok(f.screen.text().includes('フローリングを掃除する'));
      assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 2);
      await f.screen.press('期限を過ぎた家事（1件）を開く'); assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 3);
      await f.screen.press('期限を過ぎた家事（1件）を閉じる'); assert.equal(f.screen.nodes().filter((node) => node.props.accessibilityRole === 'checkbox').length, 2);
      await f.screen.press('引き受ける');
      let model = await f.preview.readModel(); const today = model.plan.range.asOfDate;
      const round = model.plan.occurrences.find((entry) => entry.anchorDate === today && entry.configuration.policy.completion === 'one');
      assert.deepEqual(round.assigneeIds, [f.preview.userId]);
      const checkbox = f.screen.nodes().find((node) => node.props.accessibilityRole === 'checkbox' && node.props.accessibilityLabel === 'フローリングを掃除するを完了');
      await checkbox.props.onPress(); await f.screen.flush(); model = await f.preview.readModel();
      assert.equal(model.plan.history.length, 1); assert.equal(model.plan.history[0].active, true);
      assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, true);
      await f.screen.press('「フローリングを掃除する」の設定'); assert.deepEqual(f.navigation.pop(), ['configuration', round.choreId]);
      await f.screen.press('実施履歴'); assert.deepEqual(f.navigation.pop(), ['history']);
      f.props.view = 'history'; f.screen.render(); assert.ok(f.screen.text().includes('実施済み')); await f.screen.press('この完了を取り消す');
      model = await f.preview.readModel(); assert.equal(model.plan.history[0].active, false); assert.ok(f.screen.text().includes('取消済み'));
      assert.equal(model.plan.occurrences.find((entry) => entry.id === round.id).completed, false);
    } finally { f.leave(); await f.preview.close(); }
  });
}

test('v2 preview discards a late read after navigation and a successful retry clears its previous loading error', async () => {
  const f = await screenFixture('ios');
  try {
    let resolve; let focus; let attempts = 0;
    const props = { ...f.props, loadSession: async () => { if (++attempts === 1) throw new Error('Temporary read failure'); return f.preview; } };
    const screen = screenHarness(screenFile, { exportName: 'V2DevelopmentPreviewScreen', props, focusEffect: (callback) => { focus = callback; } });
    const leave = focus(); for (let i = 0; i < 15 && !screen.text().includes('Temporary read failure'); i++) await screen.flush();
    assert.ok(screen.text().includes('Temporary read failure')); await screen.press('読み込みを再試行'); assert.ok(!screen.text().includes('Temporary read failure'));
    props.loadSession = () => new Promise((ready) => { resolve = ready; }); screen.render(); const leaveNext = focus(); leaveNext();
    resolve(f.preview); await screen.flush(); assert.ok(!screen.text().includes('Temporary read failure')); leave();
  } finally { f.leave(); await f.preview.close(); }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} v2 date route carries the actual group occurrence and subject into a signed form without opening a private chore`, async () => {
    const f = await screenFixture(platform); let cleanup;
    try {
      const model = await f.preview.readModel(); const round = model.plan.occurrences.find((r) => r.anchorDate === model.plan.range.asOfDate && r.configuration.policy.completion === 'one');
      const params = { view: 'round', occurrenceId: round.id, subjectId: round.subjects[0].id }; const navigation = []; let focus;
      const screen = screenHarness('src/app/development/sharing-v2-preview.tsx', { platform, params,
        navigate: (...args) => navigation.push(args), focusEffect: (callback) => { focus = callback; },
        transformSource: (path, source) => path.endsWith('/sharing-v2-preview.tsx') ? source.replaceAll('__DEV__', 'true') : source,
        mocks: { '@/platform/sharing/development-v2-preview': { developmentV2Preview: async () => f.preview } } });
      cleanup = focus(); for (let i = 0; i < 30 && !screen.text().includes('日時を変更'); i++) await screen.flush();
      await screen.press('日時を変更'); assert.equal(navigation[0][0], 'push');
      assert.equal(navigation[0][1].pathname, '/development/sharing-v2-preview'); assert.deepEqual(navigation[0][1].params, { view: 'date', occurrenceId: round.id, subjectId: round.subjects[0].id });
      Object.assign(params, navigation[0][1].params); screen.render(); await screen.change('実施日', '2026-10-28'); await screen.press('日時を指定・申請する');
      for (let i = 0; i < 30 && !screen.text().includes('日時指定を端末に保存'); i++) await screen.flush();
      assert.ok(screen.text().includes('日時指定を端末に保存')); const next = await f.preview.readModel();
      assert.deepEqual(next.plan.occurrences.find((r) => r.id === round.id).subjects[0].formalDate.target, { precision: 'date', date: '2026-10-28' });
      params.subjectId = 'unrelated-private-id'; screen.render(); assert.ok(screen.text().includes('対象の家事回を表示できません')); assert.equal(screen.nodes().some((n) => n.type === 'TextInput'), false);
    } finally { cleanup?.(); f.leave(); await f.preview.close(); }
  });
}
