import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { recoverSharedRoster, sharedRosterDigest, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { signV2RecoveryWitness } from '../src/features/sharing/v2/recovery-witness.ts';
import { openV2RecoveryHeader, sealV2RecoveryHeader, v2RecoveryReviewDigest } from '../src/features/sharing/v2/recovery-encryption.ts';
import { validateV2RecoveryCloudRecord } from '../src/features/sharing/v2/recovery-cloud-contract.ts';

async function setup() {
  const f = await fixture(); const previous = f.archive.at(-1); const next = recoverSharedRoster(previous, f.identities.owner, [f.identities.a.deviceId]);
  const body = { schemaVersion: 1, groupId, snapshotId: 'private-recovery-proof', ownerUserId: 'owner', ownerDeviceId: f.identities.owner.deviceId,
    previousRosterDigest: sharedRosterDigest(previous), nextRosterDigest: sharedRosterDigest(next), previousKeyVersion: previous.body.keyVersion, keyVersion: next.body.keyVersion,
    baselineSequence: 4, throughSequence: 5, baselineIndexDigest: 'b'.repeat(64), retainedIndexDigest: 'c'.repeat(64), reviewDigest: 'd'.repeat(64),
    entries: [{ operationId: 'private-operation-number', uploadSequence: 5, authorUserId: 'a', authorDeviceId: f.identities.a.deviceId,
      keyVersion: previous.body.keyVersion, rawDigest: 'e'.repeat(64), receiptDigest: 'f'.repeat(64), classification: 'invalidAuthentication', preservedFactDigest: null }] };
  const witness = signV2RecoveryWitness(body, [], f.identities.owner); const { preservedFacts: _facts, ...header } = witness;
  const key = await crypto.randomBytes(32); const archive = [...f.archive, next];
  const encrypted = await sealV2RecoveryHeader(crypto, header, key, f.identities.owner);
  return { ...f, next, archive, header, key, encrypted, expected: { groupId, snapshotId: body.snapshotId, keyVersion: body.keyVersion } };
}
test('recovery headers keep private history digests and reviewed event numbers encrypted across owner handoff', async () => {
  const f = await setup(); const json = JSON.stringify(f.encrypted);
  for (const value of ['private-operation-number', 'baselineIndexDigest', f.header.body.baselineIndexDigest, f.header.body.retainedIndexDigest,
    f.header.body.entries[0].rawDigest, 'invalidAuthentication']) assert.equal(json.includes(value), false);
  assert.deepEqual(await openV2RecoveryHeader(crypto, f.encrypted, f.key, f.archive, f.expected), f.header);
  const handed = transferSharedOwnership(f.next, f.identities.owner, { userId: 'b', deviceId: f.identities.b.deviceId });
  assert.deepEqual(await openV2RecoveryHeader(crypto, f.encrypted, f.key, [...f.archive, handed], f.expected), f.header);
  const second = await sealV2RecoveryHeader(crypto, f.header, f.key, f.identities.owner);
  assert.notEqual(second.nonce, f.encrypted.nonce); assert.notEqual(second.salt, f.encrypted.salt);
});
test('recovery encryption rejects re-signed ciphertext corruption purpose swaps changed groups wrong keys and forged inner owners', async () => {
  const f = await setup();
  for (const expected of [{ ...f.expected, groupId: 'foreign' }, { ...f.expected, snapshotId: 'another' }, { ...f.expected, keyVersion: f.expected.keyVersion - 1 }]) {
    await assert.rejects(openV2RecoveryHeader(crypto, f.encrypted, f.key, f.archive, expected));
  }
  await assert.rejects(openV2RecoveryHeader(crypto, f.encrypted, new Uint8Array(32), f.archive, f.expected));
  const { signature: _signature, ...body } = f.encrypted;
  const edited = { ...body, encryptedPayload: `${body.encryptedPayload.startsWith('00') ? 'ff' : '00'}${body.encryptedPayload.slice(2)}` };
  await assert.rejects(openV2RecoveryHeader(crypto, { ...edited, signature: signSharedDocument(edited, f.identities.owner) }, f.key, f.archive, f.expected));
  const swapped = { ...body, snapshotId: f.expected.snapshotId };
  await assert.rejects(openV2RecoveryHeader(crypto, { ...swapped, signature: signSharedDocument(swapped, f.identities.owner) }, f.key, f.archive, f.expected));
  const inner = { body: f.header.body, signature: signSharedDocument({ domain: 'liflow-v2-owner-recovery-v1', body: f.header.body }, f.identities.b) };
  await assert.rejects(openV2RecoveryHeader(crypto, await sealV2RecoveryHeader(crypto, inner, f.key, f.identities.owner), f.key, f.archive, f.expected));
});
test('review commitments depend on a hidden owner proof and cloud records cannot include plaintext review or secret fields', async () => {
  const f = await setup(); const review = { privateName: '週に一度の非公開の家事', count: 1 };
  const digest = v2RecoveryReviewDigest(review, f.identities.owner);
  assert.equal(v2RecoveryReviewDigest(review, f.identities.owner), digest);
  assert.notEqual(sharedDocumentDigest(review), digest); assert.notEqual(v2RecoveryReviewDigest(review, f.identities.b), digest);
  assert.notEqual(v2RecoveryReviewDigest({ ...review, count: 2 }, f.identities.owner), digest);
  const record = { schemaVersion: 1, snapshotId: f.expected.snapshotId, previousKeyVersion: f.expected.keyVersion - 1, keyVersion: f.expected.keyVersion,
    throughSequence: 5, lockId: 'confirmed-review', reviewDigest: digest, encryptedHeaderJson: JSON.stringify(f.encrypted) };
  assert.deepEqual(validateV2RecoveryCloudRecord(record, groupId), record);
  assert.throws(() => validateV2RecoveryCloudRecord({ ...record, plaintextReview: review }, groupId));
  assert.throws(() => validateV2RecoveryCloudRecord({ ...record, groupKey: 'never upload' }, groupId));
  assert.throws(() => validateV2RecoveryCloudRecord({ ...record, snapshotId: 'different' }, groupId));
});
