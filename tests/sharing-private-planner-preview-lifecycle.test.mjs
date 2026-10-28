import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

function fixture(create) {
  const effects = []; const prior = globalThis.__DEV__; globalThis.__DEV__ = true;
  const screen = screenHarness('src/app/development/private-planner-sync-preview.tsx', { params: { host: '127.0.0.1', port: '8185', attempt: 'lifecycle' },
    effect: effect => effects.push(effect), mocks: {
      '../../platform/sharing/private-planner-preview': { createPrivatePlannerPreview: create },
      '../../features/sharing/private-planner/preference-screen': { PrivatePreferenceScreen: props => ({ type: 'PreferenceScreen', props }) },
    } });
  const restore = () => { if (prior === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = prior; };
  const load = () => screen.nodes().find(node => node.type === 'PreferenceScreen').props.load();
  return { effects, load, restore };
}
const context = id => ({ store: { id }, engine: { id }, synchronize: async () => {}, close: async () => {} });
test('private planner preview lifecycle never reuses a terminated SDK session after effect cleanup and restart', async t => {
  let opens = 0; let closes = 0; const f = fixture(async () => ({ ...context(++opens), close: async () => closes++ })); t.after(f.restore);
  const cleanup = f.effects[0](); assert.equal((await f.load()).store.id, 1); cleanup(); f.effects[0](); await Promise.resolve();
  assert.equal((await f.load()).store.id, 2); assert.equal(opens, 2); assert.equal(closes, 1);
});
test('private planner preview lifecycle fences an old pending context when a new mount has already prepared another SDK session', async t => {
  let release; let opens = 0; let closed = 0; const old = new Promise(resolve => { release = resolve; });
  const f = fixture(() => ++opens === 1 ? old : Promise.resolve(context(2))); t.after(f.restore);
  const cleanup = f.effects[0](); const stale = f.load().then(value => ({ value }), error => ({ error })); cleanup(); f.effects[0]();
  const current = f.load(); const attempted = opens; release({ ...context(1), close: async () => closed++ });
  const before = await stale; const after = await current; await Promise.resolve();
  assert.equal(attempted, 2); assert.match(before.error?.message ?? '', /検査画面/u); assert.equal(after.store.id, 2); assert.equal(closed, 1);
});
