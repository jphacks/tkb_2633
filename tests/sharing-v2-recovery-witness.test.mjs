import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, removeSharedMembers, sharedRosterDigest, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { signV2RecoveryWitness, validateV2RecoveryWitness, verifyV2RecoveryWitnesses } from '../src/features/sharing/v2/recovery-witness.ts';

async function setup() {
  const f = await fixture(); const previous = f.archive.at(-1);
  const rejected = f.make('chore', { name: 'Transport corrupted this synthetic operation' }, { actor: 'a', entityId: 'floor' });
  f.make('chore', { name: 'Preserved original pending edit' }, { actor: 'a', entityId: 'floor' });
  const fact = f.facts.at(-1); const receipt = f.receipts.get(fact.operation.operationId);
  const held = { fact, receipt };
  const next = removeSharedMembers(previous, f.identities.owner, ['a']); const archive = [...f.archive, next];
  const entry = { operationId: rejected.operationId, uploadSequence: 5, authorUserId: 'a', authorDeviceId: f.identities.a.deviceId,
    keyVersion: previous.body.keyVersion, rawDigest: 'a'.repeat(64), receiptDigest: 'b'.repeat(64), classification: 'invalidAuthentication', preservedFactDigest: null };
  const body = { schemaVersion: 1, groupId, snapshotId: 'owner-reviewed-recovery', ownerUserId: 'owner', ownerDeviceId: f.identities.owner.deviceId,
    previousRosterDigest: sharedRosterDigest(previous), nextRosterDigest: sharedRosterDigest(next), previousKeyVersion: previous.body.keyVersion,
    keyVersion: next.body.keyVersion, baselineSequence: 4, throughSequence: 6, baselineIndexDigest: 'c'.repeat(64), retainedIndexDigest: 'd'.repeat(64),
    reviewDigest: 'e'.repeat(64), entries: [entry, { ...entry, operationId: fact.operation.operationId, uploadSequence: 6,
      rawDigest: 'f'.repeat(64), classification: 'blockedCausality', receiptDigest: sharedDocumentDigest(receipt), preservedFactDigest: sharedDocumentDigest(held) }] };
  const witness = signV2RecoveryWitness(body, [held], f.identities.owner);
  const resign = (change, signer = f.identities.owner, preservedFacts = witness.preservedFacts) => {
    const body = { ...witness.body, ...change };
    return { body, signature: signSharedDocument({ domain: 'liflow-v2-owner-recovery-v1', body }, signer), preservedFacts };
  };
  return { ...f, previous, next, archive, body, witness, resign };
}

test('recovery witness binds the historical owner epochs and preserves a revoked authors original held fact and receipt', async () => {
  const f = await setup();
  assert.deepEqual(verifyV2RecoveryWitnesses([f.witness], f.archive, groupId), [f.witness]);
  const changed = transferSharedOwnership(f.next, f.identities.owner, { userId: 'b', deviceId: f.identities.b.deviceId });
  assert.deepEqual(verifyV2RecoveryWitnesses([f.witness], [...f.archive, changed], groupId), [f.witness]);
  assert.equal(f.witness.preservedFacts[0].fact.operation.authorUserId, 'a');
  assert.equal(f.witness.preservedFacts[0].fact.operation.payload.name, 'Preserved original pending edit');
});

test('recovery witness rejects member signatures owner substitutions foreign groups and unpinned epochs', async () => {
  const f = await setup();
  for (const witness of [f.resign({}, f.identities.b), f.resign({ ownerDeviceId: f.identities.owner2.deviceId }, f.identities.owner2),
    f.resign({ ownerUserId: 'b', ownerDeviceId: f.identities.b.deviceId }, f.identities.b),
    f.resign({ groupId: 'other-group' }), f.resign({ previousRosterDigest: '0'.repeat(64) }), f.resign({ nextRosterDigest: '1'.repeat(64) }),
    f.resign({ entries: f.body.entries.map(entry => ({ ...entry, authorDeviceId: f.identities.b.deviceId })) })]) {
    assert.throws(() => verifyV2RecoveryWitnesses([witness], f.archive, groupId));
  }
});

test('recovery witness refuses key rollback device grants and replayed quarantine records', async () => {
  const f = await setup(); const outsider = await createDeviceIdentity(crypto);
  const granted = approveSharedDevice(f.previous, f.identities.owner, 'outsider', outsider);
  const witness = f.resign({ nextRosterDigest: sharedRosterDigest(granted) });
  assert.throws(() => verifyV2RecoveryWitnesses([witness], [...f.archive.slice(0, -1), granted], groupId), /cannot add/);
  assert.throws(() => verifyV2RecoveryWitnesses([f.witness, f.witness], f.archive, groupId));
  for (const change of [{ keyVersion: f.body.previousKeyVersion }, { throughSequence: 4 }, { baselineSequence: 7 },
    { entries: [...f.body.entries].reverse() }, { entries: [f.body.entries[0], f.body.entries[0]] },
    { entries: f.body.entries.map(entry => ({ ...entry, uploadSequence: 7 })) }]) {
    assert.throws(() => validateV2RecoveryWitness(f.resign(change)));
  }
});

test('recovery witness cannot lose alter or forge a held original fact even when the owner re-signs its new digest', async () => {
  const f = await setup();
  assert.throws(() => validateV2RecoveryWitness(f.resign({}, f.identities.owner, [])), /lost/);
  const held = structuredClone(f.witness.preservedFacts[0]); held.fact.operation.payload.name = 'Forged by snapshot owner';
  const changed = f.resign({ entries: [f.body.entries[0], { ...f.body.entries[1], preservedFactDigest: sharedDocumentDigest(held) }] }, f.identities.owner, [held]);
  assert.throws(() => verifyV2RecoveryWitnesses([changed], f.archive, groupId), /signature/);
  const receipt = structuredClone(f.witness.preservedFacts[0]); receipt.receipt.receivedAtMs++;
  assert.throws(() => validateV2RecoveryWitness(f.resign({}, f.identities.owner, [receipt])), /digest/);
});

test('recovery witness parsing is bounded exact and detached from caller-owned mutable objects', async () => {
  const f = await setup(); const parsed = validateV2RecoveryWitness(f.witness);
  f.witness.body.entries[0].rawDigest = '0'.repeat(64);
  assert.equal(parsed.body.entries[0].rawDigest, 'a'.repeat(64));
  assert.throws(() => validateV2RecoveryWitness({ ...parsed, plaintext: 'unreviewed' }));
  assert.throws(() => validateV2RecoveryWitness({ ...parsed, body: { ...parsed.body, autoSkip: true } }));
  assert.throws(() => validateV2RecoveryWitness({ ...parsed, body: { ...parsed.body, entries: Array(257).fill(parsed.body.entries[0]) } }));
  assert.throws(() => verifyV2RecoveryWitnesses(Array(65).fill(parsed), f.archive, groupId));
});
