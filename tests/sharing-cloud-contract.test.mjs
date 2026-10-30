import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { assertSharedCloudAccess, boundedSharingCloudBatches, MAX_SHARED_CLOUD_BATCH_BYTES,
  parseSharedCloudEvent, parseSharedCloudGroup, rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';

test('cloud ACL metadata cannot substitute a pinned signed account, device or membership epoch', async () => {
  const owner = await createDeviceIdentity(crypto); const roster = createSharedRoster('group-test', 'owner', owner);
  const data = { ...rosterCloudFields(roster), headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 };
  assert.equal(parseSharedCloudGroup(data, 'group-test').group.ownerUserId, 'owner');
  for (const change of [{ ownerUserId: 'attacker' }, { deviceOwners: { [owner.deviceId]: 'attacker' } },
    { memberIds: ['owner', 'attacker'] }, { keyVersion: 2 }, { taskName: '平文の家事' }, { snapshotThroughSequence: 1 }]) {
    assert.throws(() => parseSharedCloudGroup({ ...data, ...change }, 'group-test'));
  }
  assert.throws(() => parseSharedCloudGroup(data, 'wrong-group'));
  assertSharedCloudAccess(data, 'owner', owner.deviceId);
  assert.throws(() => assertSharedCloudAccess(data, 'attacker'), { code: 'sharing/access-denied' });
  assert.throws(() => assertSharedCloudAccess({ ...data, revokedUserIds: ['owner'], rotationRequired: true }, 'owner'), { code: 'sharing/access-denied' });
});

test('large encrypted snapshot batches respect both the 100-document limit and the Firestore request byte limit', () => {
  const small = boundedSharingCloudBatches(Array.from({ length: 250 }, (_, index) => index), () => 1000);
  assert.deepEqual(small.map((page) => page.length), [100, 100, 50]);
  const sizes = Array.from({ length: 40 }, (_, index) => 640000 + index);
  const large = boundedSharingCloudBatches(sizes, (size) => size);
  assert.ok(large.length > 1); assert.deepEqual(large.flat(), sizes);
  assert.ok(large.every((page) => page.length <= 100 && page.reduce((sum, size) => sum + size, 0) <= MAX_SHARED_CLOUD_BATCH_BYTES));
  assert.throws(() => boundedSharingCloudBatches([MAX_SHARED_CLOUD_BATCH_BYTES + 1], (size) => size));
});

test('cloud event positions and author metadata must bind the encrypted envelope and never accept extra plaintext fields', () => {
  const envelope = { schemaVersion: 1, operationId: 'operation-test', groupId: 'group-test', authorUserId: 'owner', authorDeviceId: 'owner-device', keyVersion: 1 };
  const data = { schemaVersion: 1, authorUserId: 'owner', authorDeviceId: 'owner-device', keyVersion: 1, uploadSequence: 1, envelopeJson: JSON.stringify(envelope) };
  assert.equal(parseSharedCloudEvent('operation-test', data, 'group-test').uploadSequence, 1);
  for (const change of [{ uploadSequence: 0 }, { uploadSequence: 1.5 }, { authorUserId: 'attacker' },
    { keyVersion: 2 }, { description: '平文の内容' }]) {
    assert.throws(() => parseSharedCloudEvent('operation-test', { ...data, ...change }, 'group-test'));
  }
  assert.throws(() => parseSharedCloudEvent('other-operation', data, 'group-test'));
  assert.throws(() => parseSharedCloudEvent('operation-test', { ...data, envelopeJson: JSON.stringify({ ...envelope, schemaVersion: 2 }) }, 'group-test'));
});
