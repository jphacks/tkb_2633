import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { Timestamp } from 'firebase/firestore';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { signSharedDocument } from '../src/features/sharing/crypto.ts';
import { removeSharedMembers } from '../src/features/sharing/roster.ts';
import { parseSharedCloudEvent } from '../src/features/sharing/cloud-contract.ts';
import { signV2RecoveryLock, validateV2RecoveryLock, verifyV2RecoveryLock } from '../src/features/sharing/v2/recovery-lock.ts';
import { parseFirestoreRecoveryLock, rawV2RecoveryEvent, recoveryLockFields, createSharingRecovery } from '../src/platform/sharing/firestore-recovery.ts';

test('recovery lock accepts only the pinned current owner device and refuses stale epochs forged signatures and altered reviews', async () => {
  const f = await fixture(); const roster = f.archive.at(-1);
  const lock = signV2RecoveryLock(roster, f.identities.owner, { id: 'review-test', throughSequence: 8, reviewDigest: 'a'.repeat(64) });
  assert.deepEqual(verifyV2RecoveryLock(lock, roster), lock);
  assert.throws(() => signV2RecoveryLock(roster, f.identities.owner2, { id: 'review-test', throughSequence: 8, reviewDigest: 'a'.repeat(64) }));
  const forged = { ...lock, signature: signSharedDocument({ domain: 'liflow-v2-owner-recovery-lock-v1', body: lock.body }, f.identities.a) };
  assert.throws(() => verifyV2RecoveryLock(forged, roster), /signature/);
  assert.throws(() => verifyV2RecoveryLock({ ...lock, body: { ...lock.body, reviewDigest: 'b'.repeat(64) } }, roster), /signature/);
  assert.throws(() => verifyV2RecoveryLock(lock, removeSharedMembers(roster, f.identities.owner, ['b'])), /epoch/);
  assert.throws(() => validateV2RecoveryLock({ ...lock, skipApproval: true }));
  assert.throws(() => validateV2RecoveryLock({ ...lock, body: { ...lock.body, id: '../outside' } }));
});

test('recovery lock Firestore metadata must match the signed header and contain a committed server timestamp', async () => {
  const f = await fixture(); const lock = signV2RecoveryLock(f.archive.at(-1), f.identities.owner,
    { id: 'review-test', throughSequence: 8, reviewDigest: 'a'.repeat(64) });
  const data = { ...recoveryLockFields(lock), createdAt: Timestamp.fromMillis(1000) };
  assert.deepEqual(parseFirestoreRecoveryLock(data), lock);
  assert.throws(() => parseFirestoreRecoveryLock({ ...data, reviewDigest: 'b'.repeat(64) }));
  assert.throws(() => parseFirestoreRecoveryLock({ ...data, createdAt: new Date() }));
  assert.throws(() => parseFirestoreRecoveryLock({ ...data, ownerPassword: 'never allowed' }));
});

test('raw recovery capture preserves malformed ciphertext JSON and floors only the immutable server timestamp', () => {
  const data = { schemaVersion: 2, authorUserId: 'member', authorDeviceId: 'device-test', keyVersion: 4,
    uploadSequence: 9, envelopeJson: '{broken', authorProofDigest: 'a'.repeat(64), createdAt: new Timestamp(1, 123456789) };
  const raw = rawV2RecoveryEvent(data, groupId, 'bad-event');
  assert.equal(raw.envelopeJson, '{broken'); assert.equal(raw.receivedAtMs, 1123);
  assert.throws(() => parseSharedCloudEvent('bad-event', data, groupId));
  assert.throws(() => rawV2RecoveryEvent({ ...data, createdAt: 1123 }, groupId, 'bad-event'));
  assert.throws(() => rawV2RecoveryEvent({ ...data, plaintext: 'not an event field' }, groupId, 'bad-event'));
});

test('recovery queries reject unsafe limits and cross-path identifiers before any account or network access', async () => {
  const unexpected = () => { throw new Error('unexpected network access'); };
  const cloud = createSharingRecovery({ firestore: {}, userId: 'owner', checkAccount: unexpected, readGroup: unexpected, reference: unexpected });
  await assert.rejects(cloud.readRawRecoveryPage(groupId, 0, 1, 101), /query window/);
  await assert.rejects(cloud.readRawRecoveryPage(groupId, 2, 1), /query window/);
  await assert.rejects(cloud.readRecoveryOriginals(groupId, ['../private']), /identifier/);
  await assert.rejects(cloud.readRecoveryOriginals(groupId, ['one', 'one']), /query/);
});
