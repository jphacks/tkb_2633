import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { buildSharedReplica, compactSharedReplica } from '../src/features/sharing/replica.ts';
import { createDeviceIdentity, signSharedOperation, sharedDocumentDigest, sealSharedSnapshotChunk,
  openSharedSnapshotChunk, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
function op(sequence, overrides = {}) {
  return { schemaVersion: 1, groupId: 'group-test', operationId: `edit-${sequence}`, authorUserId: 'owner',
    authorDeviceId: 'device-a', deviceSequence: sequence, logicalClock: sequence,
    context: sequence > 1 ? { 'device-a': sequence - 1 } : {}, keyVersion: 1,
    entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: `床掃除 ${sequence}` }, ...overrides };
}
const state = ({ entities, completions, frontier, logicalClock, pendingOperationIds }) => ({ entities, completions, frontier, logicalClock, pendingOperationIds });

test('shared snapshots compact superseded edits while preserving receipt collisions, causal frontiers and future offline edits', () => {
  const operations = Array.from({ length: 1000 }, (_, index) => op(index + 1));
  const before = buildSharedReplica('group-test', operations); const base = compactSharedReplica(before);
  assert.equal(base.operations.length, 1); assert.equal(base.operationIndex.length, 1000);
  assert.deepEqual(state(buildSharedReplica('group-test', [], base)), state(before));
  const offline = op(1, { operationId: 'offline-b', authorDeviceId: 'device-b', context: {}, payload: { name: 'オフライン編集' } });
  const following = op(1001, { logicalClock: 1002, context: { 'device-a': 1000, 'device-b': 1 }, payload: { category: '居室' } });
  const expected = state(buildSharedReplica('group-test', [...operations, offline, following]));
  for (const input of [[offline, following], [following, offline], [following, operations[25], offline, following]]) {
    assert.deepEqual(state(buildSharedReplica('group-test', input, base)), expected);
  }
  assert.throws(() => buildSharedReplica('group-test', [{ ...operations[25], payload: { name: 'ID再利用' } }], base), /reused/);
  assert.throws(() => buildSharedReplica('group-test', [{ ...operations[25], operationId: 'dot-reuse' }], base), /reused/);
});

test('snapshot compaction preserves concurrent deletion conflicts and every completion fact and targeted undo', () => {
  const first = op(1); const deletion = op(2, { operationType: 'delete', payload: {} });
  const concurrent = op(1, { operationId: 'concurrent-b', authorDeviceId: 'device-b', payload: { name: '並行編集' } });
  const completed = op(3, { entityType: 'completion', entityId: 'occurrence', operationType: 'complete',
    payload: { choreId: 'floor', completedAt: '2026-10-27T01:00:00Z', outcome: 'completed' } });
  const second = op(2, { operationId: 'completed-b', authorDeviceId: 'device-b', logicalClock: 2, context: { 'device-b': 1 },
    entityType: 'completion', entityId: 'occurrence', operationType: 'complete', payload: completed.payload });
  const undo = op(4, { entityType: 'completion', entityId: 'occurrence', operationType: 'undo', payload: { targetOperationId: completed.operationId } });
  const operations = [first, deletion, concurrent, completed, second, undo];
  const original = buildSharedReplica('group-test', operations); const base = compactSharedReplica(original);
  assert.deepEqual(state(buildSharedReplica('group-test', [], base)), state(original));
  assert.equal(original.entities[0].deleted, true); assert.equal(original.completions[0].operationId, second.operationId);
  const laterUndo = op(5, { logicalClock: 6, context: { 'device-a': 4, 'device-b': 2 }, entityType: 'completion', entityId: 'occurrence',
    operationType: 'undo', payload: { targetOperationId: second.operationId } });
  assert.deepEqual(state(buildSharedReplica('group-test', [laterUndo], base)), state(buildSharedReplica('group-test', [...operations, laterUndo])));
});

test('incomplete causal history and altered snapshot receipts cannot be compacted or used as a receive baseline', () => {
  assert.throws(() => compactSharedReplica(buildSharedReplica('group-test', [op(2)])), /incomplete/);
  const base = compactSharedReplica(buildSharedReplica('group-test', [op(1), op(2)]));
  for (const changed of [ { frontier: { 'device-a': 3 } }, { operationIndex: base.operationIndex.slice(1) },
    { operationIndex: [{ ...base.operationIndex[0], digest: '00'.repeat(32) }, base.operationIndex[1]] },
    { operations: [{ ...base.operations[0], payload: { name: '改ざん' } }] }, { logicalClock: 0 } ]) {
    // A discarded receipt's digest has no fact to authenticate, so mutate the retained receipt too.
    if (changed.operationIndex?.length === 2) changed.operationIndex[1] = { ...changed.operationIndex[1], digest: '00'.repeat(32) };
    assert.throws(() => buildSharedReplica('group-test', [], { ...base, ...changed }));
  }
});

async function encryptedFixture(count = 3000) {
  const owner = await createDeviceIdentity(crypto); const roster = createSharedRoster('group-test', 'owner', owner);
  const operations = Array.from({ length: count }, (_, index) => op(index + 1, { authorDeviceId: owner.deviceId,
    context: index ? { [owner.deviceId]: index } : {}, payload: { name: '秘密の掃除 ' + index } }));
  const replica = buildSharedReplica('group-test', operations); const author = () => owner;
  const facts = [signSharedOperation(operations.at(-1), owner)]; const key = await crypto.randomBytes(32);
  const encrypted = await createEncryptedSharedSnapshot(crypto, replica, facts, roster, owner, key, 'snapshot-test', count, author);
  return { owner, roster, operations, replica, facts, key, encrypted, author };
}

test('encrypted snapshots restore a long offline device from bounded chunks without uploading names, bodies or private keys', async () => {
  const h = await encryptedFixture(); assert.ok(h.encrypted.chunks.length >= 3);
  const encoded = canonicalJson(h.encrypted);
  for (const privateValue of ['秘密の掃除', 'floor', h.owner.signingSecretKey, h.owner.agreementSecretKey]) assert.ok(!encoded.includes(privateValue));
  assert.ok(h.encrypted.chunks.every((chunk) => JSON.stringify(chunk).length < 800000));
  const restored = await openEncryptedSharedSnapshot(crypto, h.encrypted, h.key, h.roster, h.author);
  assert.equal(restored.throughSequence, 3000); assert.equal(restored.facts.length, 1);
  assert.deepEqual(state(buildSharedReplica('group-test', [], restored.base)), state(h.replica));
  const next = op(3001, { authorDeviceId: h.owner.deviceId, context: { [h.owner.deviceId]: 3000 } });
  assert.deepEqual(state(buildSharedReplica('group-test', [next], restored.base)), state(buildSharedReplica('group-test', [...h.operations, next])));
});

test('snapshot ciphertext tampering, page swaps, missing chunks, wrong group keys and stale manifests fail closed', async () => {
  const h = await encryptedFixture(1001);
  await assert.rejects(openEncryptedSharedSnapshot(crypto, h.encrypted, await crypto.randomBytes(32), h.roster, h.author));
  for (const chunks of [h.encrypted.chunks.slice(1), [...h.encrypted.chunks].reverse(),
    [{ ...h.encrypted.chunks[0], nonce: '00'.repeat(12) }, ...h.encrypted.chunks.slice(1)]]) {
    await assert.rejects(openEncryptedSharedSnapshot(crypto, { ...h.encrypted, chunks }, h.key, h.roster, h.author));
  }
  const manifest = { ...h.encrypted.manifest, body: { ...h.encrypted.manifest.body, throughSequence: 99999 } };
  await assert.rejects(openEncryptedSharedSnapshot(crypto, { ...h.encrypted, manifest }, h.key, h.roster, h.author));
  await assert.rejects(createEncryptedSharedSnapshot(crypto, h.replica, [], h.roster, h.owner, h.key, 'no-proof', 1001, h.author), /proof/);
});

test('a valid owner snapshot envelope cannot conceal a changed original author proof', async () => {
  const h = await encryptedFixture(1); const old = h.encrypted.chunks[0];
  const context = { groupId: 'group-test', snapshotId: 'snapshot-test', chunkIndex: 0, keyVersion: 1 };
  const records = JSON.parse(new TextDecoder().decode(await openSharedSnapshotChunk(crypto, old, context, h.key, h.owner)));
  records.find((record) => record.kind === 'fact').value.operation.payload.name = '署名済み本文の偽装';
  const chunk = await sealSharedSnapshotChunk(crypto, new TextEncoder().encode(canonicalJson(records)), context, h.key, h.owner);
  const body = { ...h.encrypted.manifest.body, chunks: [{ id: 'snapshot-test.0', digest: sharedDocumentDigest(chunk), bytes: new TextEncoder().encode(canonicalJson(chunk)).length }] };
  const manifest = { body, signature: signSharedDocument({ domain: 'liflow-shared-snapshot-v1', body }, h.owner) };
  await assert.rejects(openEncryptedSharedSnapshot(crypto, { manifest, chunks: [chunk] }, h.key, h.roster, h.author), /signature/);
});
