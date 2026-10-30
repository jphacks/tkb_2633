import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2PairScope, createV2NativePair, V2_PAIR_PROJECT } from '../src/features/sharing/development/v2-native-pair.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { saveSharingWorkspace } from '../src/platform/storage/sharing-registry.ts';
import { initializeSharingLedger, createLocalSharedOperation, deferSharingUpload } from '../src/platform/storage/sharing-ledger.ts';

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

test('native QA can prove a removed device retains delayed outbox changes without network access or exposing their contents', async () => {
  const h = createDatabase(); const registry = createDatabase(); const identity = await createDeviceIdentity(crypto);
  const scope = v2PairScope(true, 'recovery-retention-a1', 'owner');
  const cloud = new Proxy({}, { get() { throw new Error('unexpected cloud access'); } });
  try {
    await initializeSharingLedger(h.database);
    const pair = await createV2NativePair({ development: true, projectId: V2_PAIR_PROJECT, run: scope.run, role: scope.role,
      database: h.database, registry: registry.database, identity, crypto, cloud, invitationSeed: new Uint8Array(32), now: () => new Date() });
    const roster = createSharedRoster(scope.groupId, scope.userId, identity, { schemaVersion: 2 });
    await saveSharingWorkspace(registry.database, { userId: scope.userId, groupId: scope.groupId, displayName: '保持検査', status: 'removed',
      anchor: roster, rosterArchive: [roster], createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: 'permission-denied' });
    await createLocalSharedOperation(h.database, { schemaVersion: 2, groupId: scope.groupId, userId: scope.userId, deviceId: identity.deviceId, keyVersion: 1 },
      { operationId: 'retained-edit', entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '内容は公開しない' } }, async () => {},
      operation => signSharedOperation(operation, identity).authorSignature);
    await deferSharingUpload(h.database, 'retained-edit', Date.now(), 0.5);
    const before = h.connection.prepare('SELECT * FROM sharing_operations').all();
    assert.deepEqual(await pair.retainedProof(), { groupId: scope.groupId, role: scope.role, status: 'removed', outbox: 1 });
    assert.deepEqual(h.connection.prepare('SELECT * FROM sharing_operations').all(), before);
    assert.equal(JSON.stringify(await pair.retainedProof()).includes('内容は公開しない'), false);
    pair.close(); await assert.rejects(pair.retainedProof(), /閉じています/u);
  } finally { h.connection.close(); registry.connection.close(); }
});

for (const development of [false, true]) test(`native QA portal ${development ? 'routes only explicit synthetic parameters' : 'hides all controls in release'}`, async () => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = development;
  try {
    const navigation = []; const h = screenHarness('src/app/development/index.tsx', { navigate: (...args) => navigation.push(args) });
    if (!development) { assert.match(h.text(), /開発ビルド専用/u); assert.equal(h.nodes().filter(node => node.props.accessibilityRole === 'button').length, 0); return; }
    await h.change('Emulator host', '192.168.1.73'); await h.press('参加者に切り替える'); await h.press('異種OSの同一グループを検査');
    assert.deepEqual(navigation, [['push', { pathname: '/development/v2-native-pair', params: { host: '192.168.1.73', port: '8186', run: 'phase6-v38-a1', role: 'member' } }]]);
  } finally { globalThis.__DEV__ = before; }
});
