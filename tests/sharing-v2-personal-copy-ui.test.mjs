import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { screenHarness } from './helpers/screen-harness.mjs';
import { prepareV2PersonalCopy } from '../src/features/sharing/v2/personal-copy.ts';
import { createHouseholdChoreDefinitions } from '../src/domain/chores/catalog.ts';

const flush = async screen => { for (let i = 0; i < 8; i++) await screen.flush(); };
function fixture() {
  const source = { scope: 'personal', ownerUserId: 'owner', householdId: 'local-household', frequencyMode: 'balanced', chores: createHouseholdChoreDefinitions('local-household') };
  Object.assign(source.chores[0], { trivia: [{ id: 'trivia-local-id', title: '確認する補足', body: '共有される補足の全文' }],
    procedureSections: [{ title: '確認する区分', steps: ['共有される区分の手順'] }], applianceCareSource: {
      manufacturer: '検査メーカー', productName: '検査製品', modelNumber: '検査型番', manualUrl: 'https://example.invalid/manual', analyzedAt: '2026-10-29T00:00:00Z',
      evidence: [{ url: 'https://example.invalid/evidence', pageOrSection: '説明書10ページ' }] } });
  const context = { userId: 'owner', administratorUserId: 'owner', groupId: 'group-a', rosterDigest: 'a'.repeat(64), groupName: '確認する家族', timeZone: 'Asia/Tokyo' };
  const state = { context, control: { revision: 0, review: null, status: null, synchronization: null },
    choices: source.chores.slice(0, 2).map(chore => ({ id: chore.id, name: chore.name, enabled: chore.enabled, requiresCycleSelection: false })) };
  const calls = []; let ordinal = 0; let fail = false;
  const runtime = { async load() { return structuredClone(state); }, async prepare(revision, ids, preset) {
    calls.push(['prepare', revision, [...ids], preset]); assert.equal(revision, state.control.revision);
    state.control = { revision: revision + 1, status: 'review', synchronization: null,
      review: prepareV2PersonalCopy(source, context, ids, preset, () => `ui-copy-${++ordinal}`, new Date('2026-10-29T01:00:00Z')) }; return structuredClone(state.control);
  }, async confirm(reference) { calls.push(['confirm', { ...reference }]); if (fail) throw new Error('source changed');
    assert.equal(reference.digest, state.control.review.digest); state.control.status = 'committed'; state.control.synchronization = 'pending'; state.control.revision++; return structuredClone(state.control);
  }, async clear(revision) { calls.push(['clear', revision]); state.control = { revision: revision + 1, review: null, status: null, synchronization: null }; return structuredClone(state.control); } };
  return { source, state, calls, runtime, fail() { fail = true; } };
}
async function open(h, platform, loader = async () => h.runtime) {
  const effects = []; let backs = 0;
  const screen = screenHarness('src/features/sharing/v2-ui/personal-copy-screen.tsx', { exportName: 'V2PersonalCopyScreen', platform,
    props: { load: loader, onBack() { backs++; } }, effect: callback => effects.push(callback) });
  effects.shift()(); await flush(screen); effects.at(-1)?.(); return { screen, effects, backs: () => backs };
}
async function choose(screen, name, checked = true) {
  const node = screen.nodes().find(row => row.type === 'Switch' && row.props.accessibilityLabel === name); assert.ok(node);
  assert.equal(node.props.value, !checked); node.props.onValueChange(checked); await flush(screen);
}
for (const platform of ['ios', 'android']) {
  test(`${platform} personal copy QA route refuses release before loading synthetic identity or data`, () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = false; let opened = 0;
    try {
      const screen = screenHarness('src/app/development/v2-personal-copy-preview.tsx', { platform, mocks: {
        '../../platform/sharing/v2-personal-copy-preview': { createV2PersonalCopyPreview() { opened++; } },
      } }); assert.match(screen.text(), /開発ビルド専用/u); assert.equal(opened, 0);
    } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
  });
  test(`${platform} personal copy starts unchecked and stages a fully readable review before explicit sharing`, async () => {
    const h = fixture(); const ui = await open(h, platform); assert.deepEqual(h.calls, []);
    assert.ok(ui.screen.nodes().filter(node => node.type === 'Switch').every(node => node.props.value === false));
    assert.equal(ui.screen.button('選んだ0件を確認').props.disabled, true);
    await choose(ui.screen, h.state.choices[0].name); await ui.screen.press('選んだ1件を確認'); await flush(ui.screen);
    assert.deepEqual(h.calls, [['prepare', 0, [h.state.choices[0].id], 'common']]); assert.equal(h.state.control.status, 'review');
    for (const text of ['確認する家族', '共有される補足の全文', '共有される区分の手順', '検査メーカー', '説明書10ページ', 'https://example.invalid/evidence']) assert.ok(ui.screen.text().includes(text));
    assert.doesNotMatch(ui.screen.text(), /trivia-local-id|ui-copy-/u);
    await ui.screen.press('確認した設定を共有へ追加'); await flush(ui.screen); assert.equal(h.calls[1][0], 'confirm');
    assert.deepEqual(Object.keys(h.calls[1][1]).sort(), ['digest', 'id']); assert.match(ui.screen.text(), /端末に保存済み・送信待ち/u);
    assert.doesNotMatch(ui.screen.text(), /保管先への送信を確認しました/u);
    await ui.screen.press('別の家事を選ぶ'); await flush(ui.screen); assert.equal(h.state.control.review, null); assert.equal(h.calls.at(-1)[0], 'clear');
  });
  test(`${platform} personal copy keeps an unconfirmed review and Back after failure or permission loss`, async () => {
    const h = fixture(); await h.runtime.prepare(0, [h.state.choices[0].id], 'eachMember'); h.calls.length = 0; h.fail();
    const ui = await open(h, platform); assert.equal(ui.screen.nodes().filter(node => node.type === 'Switch').length, 0);
    assert.match(ui.screen.text(), /各人別/u); await ui.screen.press('確認した設定を共有へ追加'); await flush(ui.screen);
    assert.match(ui.screen.text(), /操作を完了できません/u); assert.equal(h.state.control.status, 'review');
    h.state.context.administratorUserId = 'new-owner'; await ui.screen.press('保存した内容を読み直す'); await flush(ui.screen);
    assert.equal(ui.screen.button('確認した設定を共有へ追加').props.disabled, true);
    await ui.screen.press('前の画面に戻る'); assert.equal(ui.backs(), 1);
  });
  test(`${platform} personal copy distinguishes an accepted send from a revoked unpublished copy without adding again`, async () => {
    for (const synchronization of ['sent', 'needsReview']) {
      const h = fixture(); await h.runtime.prepare(0, [h.state.choices[0].id], 'common'); await h.runtime.confirm(h.state.control.review);
      h.state.control.synchronization = synchronization; h.calls.length = 0; const ui = await open(h, platform);
      assert.match(ui.screen.text(), synchronization === 'sent' ? /取得は各端末の同期後/u : /共有前の確認が必要/u);
      assert.equal(ui.screen.nodes().some(node => node.props.accessibilityLabel === '確認した設定を共有へ追加'), false); assert.deepEqual(h.calls, []);
    }
  });
  test(`${platform} personal copy load failure retains retry and Back without preparing any copy`, async () => {
    const h = fixture(); const ui = await open(h, platform, async () => { throw new Error('offline disk'); });
    assert.match(ui.screen.text(), /元の家事と確認内容は保持/u); ui.screen.button('コピー内容を再読込');
    await ui.screen.press('前の画面に戻る'); assert.equal(ui.backs(), 1); assert.deepEqual(h.calls, []);
  });
  test(`${platform} personal copy route blocks v1 and foreign accounts before opening the personal reader`, () => {
    for (const active of [null, { protocol: 1 }, { protocol: 2, userId: 'foreign', identity: { deviceId: 'foreign' } }]) {
      let opened = 0; const screen = screenHarness('src/app/group-v2/personal-copy.tsx', { platform, mocks: {
        '../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: 'owner', active }) },
        '../../platform/sharing/v2-personal-copy': { createNativeV2PersonalCopy() { opened++; } },
        '../../features/sharing/v2-ui/personal-copy-screen': { V2PersonalCopyScreen() { opened++; return null; } },
      } }); assert.match(screen.text(), /コピー先の共有グループ/u); assert.equal(opened, 0);
    }
  });
  test(`${platform} personal copy route fences old handlers after a selection switch or leaving the screen`, async () => {
    const active = { protocol: 2, userId: 'owner', groupId: 'group-a', identity: { deviceId: 'device' }, record: async () => ({ status: 'active' }), session: { repository: {} } };
    const context = { ready: true, userId: 'owner', active }; const effects = []; let load; let access;
    const screen = screenHarness('src/app/group-v2/personal-copy.tsx', { platform, layoutEffect: callback => effects.push(callback), mocks: {
      '../../hooks/use-workspace': { useWorkspace: () => context },
      '../../platform/sharing/v2-personal-copy': { createNativeV2PersonalCopy(input) { access = input.assertAccess; return {}; } },
      '../../features/sharing/v2-ui/personal-copy-screen': { V2PersonalCopyScreen(props) { load = props.load; return null; } },
    } }); const cleanup = effects.shift()(); await load(); await access();
    context.active = { ...active, groupId: 'group-b' }; screen.render(); effects.at(-1)(); await assert.rejects(access(), /変わり/u);
    cleanup(); await assert.rejects(load(), /変わり/u);
  });
}
