import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { encryptSharedOperation, signSharedDocument, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { analyzeV2Recovery } from '../src/features/sharing/v2/recovery-analysis.ts';

async function setup() {
  const f = await fixture(); const seed = f.facts.map(value => value.operation); const key = await crypto.randomBytes(32);
  const baseline = buildSharedReplica(groupId, seed);
  const raw = async (fact, tampered = false, malformed = false) => {
    const actor = fact.operation.authorUserId;
    const envelope = await encryptSharedOperation(crypto, fact.operation, key, f.identities[actor]);
    if (tampered) {
      const { signature: _old, ...body } = envelope;
      body.encryptedPayload = `${body.encryptedPayload.startsWith('00') ? 'ff' : '00'}${body.encryptedPayload.slice(2)}`;
      Object.assign(envelope, body, { signature: signSharedDocument(body, f.identities[actor]) });
    }
    const receipt = f.receipts.get(fact.operation.operationId);
    return { schemaVersion: 2, groupId, operationId: fact.operation.operationId, authorUserId: actor, authorDeviceId: fact.operation.authorDeviceId,
      keyVersion: envelope.keyVersion, uploadSequence: receipt.uploadSequence, envelopeJson: malformed ? '{invalid-json' : canonicalJson(envelope),
      authorProofDigest: receipt.authorProofDigest, receivedAtMs: receipt.receivedAtMs };
  };
  const fact = (actor, name, options = {}) => { f.make('chore', { name }, { actor, entityId: 'floor', ...options }); return f.facts.at(-1); };
  const analyze = (events, originals = [], receipts = f.receipts) => analyzeV2Recovery({ crypto, key, archive: f.archive, baseline, baselineSequence: 4,
    throughSequence: 4 + events.length, events, originals, receipts });
  return { ...f, seed, key, raw, fact, analyze, baseline };
}

test('recovery analysis preserves independent valid edits and does not publish unrelated local outbox values', async () => {
  const f = await setup(); const bad = f.fact('a', 'corrupt'); const good = f.fact('b', '独立した正常な変更', { observed: f.seed });
  const offline = f.fact('owner', '未送信の値は共有しない', { observed: f.seed, delivered: false });
  const result = await f.analyze([await f.raw(bad, true), await f.raw(good)], [offline]);
  assert.equal(result.unreadableChanges, 1); assert.equal(result.heldChanges, 0);
  assert.deepEqual(result.removeDeviceIds, [f.identities.a.deviceId]); assert.deepEqual(result.readyFacts, [good]);
  assert.equal(result.retainedBase.operations.some(op => op.operationId === offline.operation.operationId), false);
  assert.equal(result.retainedBase.operations.find(op => op.operationId === good.operation.operationId).payload.name, '独立した正常な変更');
});

test('recovery analysis keeps causally blocked signed originals and server receipts without inventing a missing causal dot', async () => {
  const f = await setup(); const bad = f.fact('a', 'corrupt'); const dependent = f.fact('a', '失わず確認待ちにする変更');
  const result = await f.analyze([await f.raw(bad, true), await f.raw(dependent)]);
  assert.equal(result.unreadableChanges, 1); assert.equal(result.heldChanges, 1); assert.deepEqual(result.readyFacts, []);
  assert.equal(result.preservedFacts[0].fact.operation.operationId, dependent.operation.operationId);
  assert.deepEqual(result.preservedFacts[0].receipt, f.receipts.get(dependent.operation.operationId));
  assert.equal(result.retainedBase.operationIndex.some(row => row.operationId === bad.operation.operationId || row.operationId === dependent.operation.operationId), false);
  assert.equal(result.retainedBase.frontier[f.identities.a.deviceId], undefined);
  assert.deepEqual(result.entries.map(entry => entry.classification), ['invalidAuthentication', 'blockedCausality']);
});

test('recovery analysis restores a damaged transport from an exact independently received original proof without revoking its healthy owner', async () => {
  const f = await setup(); const original = f.fact('owner', '元の署名付き変更を復元');
  const result = await f.analyze([await f.raw(original, true)], [original]);
  assert.equal(result.restoredOriginals, 1); assert.equal(result.unreadableChanges, 0); assert.deepEqual(result.removeDeviceIds, []);
  assert.deepEqual(result.readyFacts, [original]); assert.deepEqual(result.preservedFacts[0].fact, original);
  assert.equal(result.entries[0].preservedFactDigest, sharedDocumentDigest(result.preservedFacts[0]));
  assert.equal(result.retainedBase.operationIndex.at(-1).digest, sharedDocumentDigest(original.operation));
});

test('recovery analysis refuses an unreadable owner event or an unbound local substitute instead of silently deleting its history', async () => {
  const f = await setup(); const original = f.fact('owner', 'must retain'); const raw = await f.raw(original, true);
  await assert.rejects(f.analyze([raw]), { code: 'sharing/recovery-original-required' });
  const forged = structuredClone(original); forged.operation.payload.name = 'not the original';
  await assert.rejects(f.analyze([raw], [forged]), { code: 'sharing/recovery-original-required' });
  assert.equal(f.baseline.operations.length, 4);
});

test('recovery analysis can capture malformed JSON but never treats a missing or modified server receipt as accepted work', async () => {
  const f = await setup(); const fact = f.fact('a', 'test'); const raw = await f.raw(fact, false, true);
  assert.equal((await f.analyze([raw])).entries[0].classification, 'invalidEnvelope');
  const receipts = new Map(f.receipts); receipts.delete(fact.operation.operationId);
  const result = await f.analyze([await f.raw(fact)], [], receipts);
  assert.equal(result.entries[0].classification, 'missingReceipt'); assert.deepEqual(result.readyFacts, []);
  receipts.set(fact.operation.operationId, { ...f.receipts.get(fact.operation.operationId), receivedAtMs: raw.receivedAtMs + 1 });
  assert.equal((await f.analyze([await f.raw(fact)], [fact], receipts)).entries[0].classification, 'missingReceipt');
});

test('recovery analysis rejects skipped positions foreign scopes duplicated events and unsupported key epochs before preparing a review', async () => {
  const f = await setup(); const fact = f.fact('a', 'valid'); const raw = await f.raw(fact);
  for (const changed of [{ ...raw, uploadSequence: 6 }, { ...raw, groupId: 'foreign' }, { ...raw, keyVersion: raw.keyVersion + 1 }]) {
    await assert.rejects(f.analyze([changed]));
  }
  await assert.rejects(f.analyze([raw, { ...raw, uploadSequence: 6 }]), { code: 'sharing/recovery-review-stale' });
});

test('a failed native crypto provider cannot classify valid data as corrupt or propose device removal', async () => {
  const f = await setup(); const fact = f.fact('a', '正常な暗号文'); const raw = await f.raw(fact);
  await assert.rejects(analyzeV2Recovery({ crypto: { ...crypto, decrypt: async () => { throw new Error('native provider unavailable'); } },
    key: f.key, archive: f.archive, baseline: f.baseline, baselineSequence: 4, throughSequence: 5, originals: [], events: [raw], receipts: f.receipts }),
  { code: 'sharing/recovery-crypto-unavailable' });
  assert.equal(f.baseline.operations.length, 4);
});
