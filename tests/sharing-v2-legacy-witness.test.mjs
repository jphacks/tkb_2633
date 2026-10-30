import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { legacyMigrationFixture as fixture } from './helpers/sharing-v2-legacy-fixture.mjs';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { transferSharedOwnership, removeSharedMember, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { verifyLegacyMigrationSource, bindLegacyMigrationWitness, verifiedLegacyMigrationPin, readVerifiedLegacyMigrationSnapshot,
  restoreLegacyMigrationSourceFromSnapshot, assertVerifiedLegacyMigration, readVerifiedLegacyMigrationSource } from '../src/features/sharing/v2/legacy-migration-source.ts';
import { signLegacyMigrationWitness } from '../src/features/sharing/v2/legacy-migration-witness.ts';

async function prepared() {
  const h = await fixture(); const checkpoint = await verifyLegacyMigrationSource(h.input);
  return { ...h, bound: bindLegacyMigrationWitness(checkpoint, h.next, h.owner, 'roommates'), history: [...h.archive, h.next] };
}
async function distribute(h, roster = h.next, history = h.history, owner = h.owner) {
  const key = await crypto.randomBytes(32); const source = readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint);
  const author = (user, device, version) => sharedAuthorIdentity(history[version - 1], user, device, version);
  const encrypted = await createEncryptedSharedSnapshot(crypto, h.bound.replica, source.facts, roster, owner, key, 'v2-distributed-source', source.throughSequence, author);
  return { key, encrypted, open: () => openEncryptedSharedSnapshot(crypto, encrypted, key, roster, author) };
}

test('v2 encrypted migration snapshots restore an exact legacy source using only the new key and original owner statement', async () => {
  const h = await prepared(); const { encrypted, open } = await distribute(h);
  const wire = JSON.stringify(encrypted);
  for (const value of ['roommates', h.input.encrypted.manifest.body.snapshotId, h.input.expectedSnapshotDigest, h.owner.signingSecretKey]) assert.ok(!wire.includes(value));
  h.key.fill(0); const opened = await open();
  const restored = restoreLegacyMigrationSourceFromSnapshot(opened, h.history, verifiedLegacyMigrationPin(h.bound.checkpoint));
  assertVerifiedLegacyMigration(restored, buildSharedReplica(h.groupId, [], opened.base), h.history);
  assert.equal(restored.sourceSnapshotDigest, h.input.expectedSnapshotDigest);
  assert.deepEqual(readVerifiedLegacyMigrationSource(restored).replica, h.bound.replica);
});

test('v2 an original migration statement survives ownership transfer removal of its signer and a later key rotation', async () => {
  const h = await prepared(); const handover = transferSharedOwnership(h.next, h.owner, { userId: 'member', deviceId: h.member.deviceId });
  const removal = removeSharedMember(handover, h.member, 'owner'); const history = [...h.history, handover, removal];
  const { open } = await distribute(h, removal, history, h.member); h.key.fill(0);
  const opened = await open(); const restored = restoreLegacyMigrationSourceFromSnapshot(opened, history);
  assertVerifiedLegacyMigration(restored, buildSharedReplica(h.groupId, [], opened.base), history);
  assert.equal(readVerifiedLegacyMigrationSource(restored).roster.body.ownerUserId, 'owner', 'historical author authority is not the new owner');
});

test('v2 migration restore rejects a member-signed source statement even inside a valid owner snapshot', async () => {
  const h = await prepared(); const snapshot = readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint);
  const witness = snapshot.base.legacyMigrationWitness;
  witness.signer = { deviceId: h.member.deviceId, signingPublicKey: h.member.signingPublicKey, agreementPublicKey: h.member.agreementPublicKey };
  witness.signature = signSharedDocument({ domain: 'liflow-legacy-migration-witness-v1', body: witness.body }, h.member);
  assert.throws(() => restoreLegacyMigrationSourceFromSnapshot(snapshot, h.history), /owner-approved source/u);
});

test('v2 a signed migration witness cannot replace an original member completion signature with an invented work fact', async () => {
  const h = await prepared(); const snapshot = readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint);
  const op = snapshot.base.operations.find(op => op.operationId === 'member-completion'); op.payload.completedAt = '2026-10-03T10:00:00Z';
  snapshot.facts.find(fact => fact.operation.operationId === op.operationId).operation = op;
  // Recompute source receipts and the owner's statement; the member's original signature is still indispensable.
  const fresh = buildSharedReplica(h.groupId, snapshot.base.operations);
  snapshot.base.operationIndex = fresh.operationIndex;
  snapshot.base.legacyMigrationWitness = signLegacyMigrationWitness({ base: snapshot.base, source: h.roster, target: h.next, owner: h.owner,
    kind: 'roommates', sourceSnapshotDigest: h.input.expectedSnapshotDigest, sourceSnapshotId: h.input.encrypted.manifest.body.snapshotId, sourceThroughSequence: h.input.expectedThroughSequence });
  assert.throws(() => restoreLegacyMigrationSourceFromSnapshot(snapshot, h.history));
});

test('v2 protected migration pins reject another valid owner statement and returned review objects cannot mutate the registered source', async () => {
  const h = await prepared(); const pin = verifiedLegacyMigrationPin(h.bound.checkpoint);
  const snapshot = readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint);
  snapshot.base.legacyMigrationWitness.body.groupKind = 'family';
  snapshot.base.legacyMigrationWitness.signature = signSharedDocument({ domain: 'liflow-legacy-migration-witness-v1', body: snapshot.base.legacyMigrationWitness.body }, h.owner);
  assert.throws(() => restoreLegacyMigrationSourceFromSnapshot(snapshot, h.history, pin), /locally pinned/u);
  h.bound.witness.body.groupKind = 'family'; h.bound.snapshot.base.legacyMigrationWitness.body.groupKind = 'family';
  assert.deepEqual(verifiedLegacyMigrationPin(h.bound.checkpoint), pin);
  assert.equal(readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint).base.legacyMigrationWitness.body.groupKind, 'roommates');
});

test('v2 migration statement removal or replacement is refused and schema1 cannot publish the encrypted migration record', async () => {
  const h = await prepared(); const missing = structuredClone(h.bound.replica); delete missing.legacyMigrationWitness;
  assert.throws(() => assertVerifiedLegacyMigration(h.bound.checkpoint, missing, h.history), /dropped or replaced/u);
  const source = readVerifiedLegacyMigrationSnapshot(h.bound.checkpoint);
  await assert.rejects(createEncryptedSharedSnapshot(crypto, h.bound.replica, source.facts, h.roster, h.owner, h.key, 'invalid-v1-container', 7,
    (user, device, version) => sharedAuthorIdentity(h.archive[version - 1], user, device, version)), /v1 snapshot/u);
});

test('v2 migration statement pages preserve a source with more than four thousand compacted receipts', async () => {
  const h = await fixture(); const values = Array.from({ length: 4100 }, (_, index) => h.op(`large-${index}`, h.owner, 'owner', index + 1, index + 1,
    index ? { [h.owner.deviceId]: index } : {}, 'chore', 'floor', { name: `共有 ${index}` }));
  const encrypted = await h.make(values, 'large-source'); const checkpoint = await verifyLegacyMigrationSource({ ...h.input, encrypted,
    expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest), expectedThroughSequence: 4100 });
  h.bound = bindLegacyMigrationWitness(checkpoint, h.next, h.owner, 'family'); h.history = [...h.archive, h.next];
  assert.equal(h.bound.witness.body.receiptPageDigests.length, 5);
  const { open } = await distribute(h); h.key.fill(0); const opened = await open();
  const restored = restoreLegacyMigrationSourceFromSnapshot(opened, h.history);
  assert.equal(readVerifiedLegacyMigrationSource(restored).replica.operationIndex.length, 4100);
});
