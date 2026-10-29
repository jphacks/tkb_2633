import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2PairScope, createV2NativePair, V2_PAIR_PROJECT } from '../src/features/sharing/development/v2-native-pair.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

test('native v2 pair refuses release unsafe identifiers production projects and shared registry before any storage call', async () => {
  assert.throws(() => v2PairScope(false, 'phase6-a1', 'owner'));
  for (const run of ['../personal', 'owner:real', '', 'A', 'x'.repeat(49)]) assert.throws(() => v2PairScope(true, run, 'owner'));
  assert.throws(() => v2PairScope(true, 'phase6-a1', 'admin'));
  for (const role of [['owner'], new String('owner'), { toString: () => 'owner' }]) assert.throws(() => v2PairScope(true, 'phase6-a1', role));
  const deny = new Proxy({}, { get() { throw new Error('unexpected storage access'); } });
  const input = { development: true, projectId: 'production', run: 'phase6-a1', role: 'owner', database: deny, registry: {}, invitationSeed: new Uint8Array(32) };
  await assert.rejects(createV2NativePair(input), /独立/u);
  await assert.rejects(createV2NativePair({ ...input, projectId: V2_PAIR_PROJECT, registry: deny }), /独立/u);
  await assert.rejects(createV2NativePair({ ...input, development: false }), /開発/u);
});

for (const development of [false, true]) test(`native QA portal ${development ? 'routes only explicit synthetic parameters' : 'hides all controls in release'}`, async () => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = development;
  try {
    const navigation = []; const h = screenHarness('src/app/development/index.tsx', { navigate: (...args) => navigation.push(args) });
    if (!development) { assert.match(h.text(), /開発ビルド専用/u); assert.equal(h.nodes().filter(node => node.props.accessibilityRole === 'button').length, 0); return; }
    await h.change('Emulator host', '192.168.1.73'); await h.press('参加者に切り替える'); await h.press('異種OSの同一グループを検査');
    assert.deepEqual(navigation, [['push', { pathname: '/development/v2-native-pair', params: { host: '192.168.1.73', port: '8186', run: 'phase6-v36-a1', role: 'member' } }]]);
  } finally { globalThis.__DEV__ = before; }
});
