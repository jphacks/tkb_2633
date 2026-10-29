import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, sharedDocumentDigest } from '../../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, upgradeSharedRoster, sharedAuthorIdentity } from '../../src/features/sharing/roster.ts';
import { createEncryptedSharedSnapshot } from '../../src/features/sharing/snapshots.ts';
import { buildSharedReplica } from '../../src/features/sharing/replica.ts';
export async function legacyMigrationFixture() {
  const groupId = 'legacy-review'; const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const initial = createSharedRoster(groupId, 'owner', owner); const roster = approveSharedDevice(initial, owner, 'member', member);
  const archive = [initial, roster]; const key = await crypto.randomBytes(32);
  const op = (id, identity, userId, sequence, clock, context, entityType, entityId, payload, operationType = 'patch') => ({
    schemaVersion: 1, operationId: id, groupId, authorUserId: userId, authorDeviceId: identity.deviceId,
    deviceSequence: sequence, logicalClock: clock, context, keyVersion: 2, entityType, entityId, payload, operationType,
  });
  const own = (n, type, id, payload) => op(`owner-${n}`, owner, 'owner', n, n, n === 1 ? {} : { [owner.deviceId]: n - 1 }, type, id, payload);
  const operations = [own(1, 'settings', 'settings', { name: '既存共有', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-01', frequencyMode: 'balanced' }),
    own(2, 'chore', 'floor', { name: '共有の床', enabled: true, userIntervalDays: 7 }),
    own(3, 'assignment', 'floor-members', { choreId: 'floor', memberIds: ['owner'] }),
    own(4, 'baseline', 'floor', { lastCompletedDate: '2026-09-25', lastCompletedEstimated: true }),
    op('member-completion', member, 'member', 1, 5, { [owner.deviceId]: 4 }, 'completion', 'old-occurrence',
      { choreId: 'floor', completedAt: '2026-10-01T10:00:00Z', completedByMemberId: 'owner', outcome: 'completed' }, 'complete'),
    op('member-undo', member, 'member', 2, 6, { [owner.deviceId]: 4, [member.deviceId]: 1 }, 'completion', 'old-occurrence', { targetOperationId: 'member-completion' }, 'undo'),
    op('owner-completion', owner, 'owner', 5, 7, { [owner.deviceId]: 4, [member.deviceId]: 2 }, 'completion', 'old-occurrence',
      { choreId: 'floor', completedAt: '2026-10-02T10:00:00Z', outcome: 'completed' }, 'complete')];
  const author = (user, device, version) => sharedAuthorIdentity(archive[version - 1], user, device, version);
  const make = async (values = operations, id = 'legacy-snapshot') => {
    const replica = buildSharedReplica(groupId, values); const facts = values.map(value => signSharedOperation(value, value.authorDeviceId === owner.deviceId ? owner : member));
    return createEncryptedSharedSnapshot(crypto, replica, facts, roster, owner, key, id, values.length, author);
  };
  const encrypted = await make();
  const input = { crypto, encrypted, key, anchor: initial, archive, expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest), expectedThroughSequence: operations.length, pendingLocalOperationIds: [] };
  const next = upgradeSharedRoster(roster, owner);
  return { groupId, owner, member, operations, archive, roster, next, key, make, input, op };
}

