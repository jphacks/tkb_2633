import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';

const defaults = { timeZone: 'Asia/Tokyo', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] };
async function open(t, platform, options = {}) {
  const f = privateCalendarSetupFixture(t, { userId: 'private-preferences-screen-owner' }); let saves = 0; let back = 0; let prevent;
  const actual = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.vault, exclusive: f.exclusive,
    assertOwner: owner => assert.equal(f.state.currentUser, owner, 'account changed') });
  const store = { read: actual.read, save: async (...args) => { saves++; return actual.save(...args); } };
  const effects = [];
  const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', { exportName: 'PrivatePreferenceScreen', platform,
    effect: callback => effects.push(callback), preventRemove: (enabled, callback) => { prevent = { enabled, callback }; },
    props: { load: async () => ({ store, defaults }), onBack: () => back++, ...options } });
  const cleanup = effects.shift()(); t.after(cleanup);
  for (let n = 0; n < 15 && !screen.text().includes('自動移動を許可する時間帯'); n++) await screen.flush();
  const field = name => { const node = screen.nodes().find(node => node.type === 'TextInput' && node.props.accessibilityLabel === name); assert.ok(node, name); return node; };
  const fill = async (name, text) => { field(name).props.onChangeText(text); await screen.flush(); };
  const blur = async name => { field(name).props.onBlur(); for (let n = 0; n < 8; n++) await screen.flush(); };
  return { f, actual, store, screen, field, fill, blur, effects, saves: () => saves, back: () => back, prevent: () => prevent };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} private preference UI autosaves explicit bands and reloads protected values without a save button`, async t => {
    const ui = await open(t, platform); assert.equal(ui.saves(), 0); assert.equal(await ui.actual.read(), null);
    assert.match(ui.screen.text(), /この端末の本人向け推奨/u); assert.equal(ui.screen.nodes().some(n => n.props.accessibilityLabel === '保存'), false);
    await ui.screen.press('月曜日の時間帯を追加'); await ui.fill('月曜日1の開始', '19:13'); await ui.blur('月曜日1の開始');
    assert.equal(ui.saves(), 0); assert.match(ui.screen.text(), /HH:mm/u);
    await ui.fill('月曜日1の終了', '20:07'); await ui.blur('月曜日1の終了');
    assert.deepEqual((await ui.actual.read()).allowedBands, [{ weekday: 1, startMinute: 1153, endMinute: 1207 }]); assert.match(ui.screen.text(), /この端末に保存済み/u);
    assert.equal(ui.field('月曜日1の開始').props.keyboardType, platform === 'ios' ? 'numbers-and-punctuation' : 'default');
    await ui.screen.press('保存済みの本人設定を再読込'); const closeReload = ui.effects.at(-1)(); t.after(closeReload);
    for (let n = 0; n < 8; n++) await ui.screen.flush();
    assert.equal(ui.field('月曜日1の開始').props.value, '19:13'); assert.equal(ui.field('月曜日1の終了').props.value, '20:07');
    assert.equal((await ui.actual.read()).revision, 1);
  });

  test(`${platform} private preference UI blocks hardware and visible back for incomplete input until explicit discard`, async t => {
    const ui = await open(t, platform); await ui.screen.press('火曜日の時間帯を追加'); await ui.fill('火曜日1の開始', '18:');
    assert.equal(ui.prevent().enabled, true); let repeated = 0; ui.prevent().callback({ repeat: () => repeated++ });
    for (let n = 0; n < 6; n++) await ui.screen.flush(); assert.equal(repeated, 0);
    await ui.screen.press('前の画面に戻る'); assert.equal(ui.back(), 0); assert.match(ui.screen.text(), /未保存の入力を修正/u);
    await ui.screen.press('未保存の入力を破棄して戻る'); for (let n = 0; n < 5; n++) await ui.screen.flush();
    assert.equal(ui.back(), 1); assert.equal(ui.saves(), 0); assert.equal(await ui.actual.read(), null);
  });

  test(`${platform} private preference route rejects unauthenticated access before Native protected storage opens`, async () => {
    let opened = 0; const moves = [];
    const screen = screenHarness('src/app/sharing/personal-preferences.tsx', { platform, mocks: {
      '../../hooks/use-workspace': { useWorkspace: () => ({ ready: true, userId: null }) },
      '../../hooks/use-planner-data': { usePlannerData: () => ({ snapshot: null }) },
      '../../platform/sharing/private-calendar-secrets': { nativePrivatePlannerPreferences: () => { opened++; throw new Error('must not open'); } },
    }, navigate: (...args) => moves.push(args) });
    assert.equal(opened, 0); await screen.press('共有用アカウントへ'); assert.deepEqual(moves.at(-1), ['replace', '/sharing']);
  });

  test(`${platform} invalid initial private preferences show a recoverable read error instead of crashing the editor or saving defaults`, async t => {
    let writes = 0;
    const ui = await open(t, platform, { load: async () => ({ defaults: { ...defaults, timeZone: 'Invalid/Zone' },
      store: { read: async () => null, save: async () => writes++ } }) });
    assert.match(ui.screen.text(), /保存済み設定を読み込めません/u); assert.equal(writes, 0); assert.equal(ui.screen.nodes().some(n => n.type === 'TextInput'), false);
  });
}

test('closing private preference settings before its loader resolves prevents a late protected read', async () => {
  let resolve; let effect; let reads = 0; const waiting = new Promise(done => { resolve = done; });
  const screen = screenHarness('src/features/sharing/private-planner/preference-screen.tsx', { exportName: 'PrivatePreferenceScreen',
    effect: callback => { effect ??= callback; }, props: { load: () => waiting, onBack() {} } });
  const cleanup = effect(); cleanup(); resolve({ defaults, store: { read: async () => { reads++; return null; } } }); await screen.flush();
  assert.equal(reads, 0);
});
