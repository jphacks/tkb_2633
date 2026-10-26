import './typescript-loader.mjs';
import { randomUUID } from 'node:crypto';
import { createDatabase } from './sqlite.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createSharedSynchronizer } from '../../src/features/sharing/synchronizer.ts';
import { createSharedGroupManager } from '../../src/features/sharing/group-manager.ts';
import { sharedRosterDigest, verifyPinnedSharedRoster } from '../../src/features/sharing/roster.ts';
import { signSharedOperation } from '../../src/features/sharing/crypto.ts';
import { sharedGroupBootstrap } from '../../src/features/sharing/planning.ts';
import { initializeSharedProjection } from '../../src/platform/storage/sharing-projection.ts';
import { initializeSharingLedger, createLocalSharedOperations, loadSharedReplica, readSharingCheckpoint } from '../../src/platform/storage/sharing-ledger.ts';
import { createSharedPlannerRepository } from '../../src/platform/storage/shared-planner-repository.ts';
import { registerSharedRepositoryAdapter } from '../../src/platform/storage/shared-repository-adapter.ts';
const repository = await import('../../src/platform/storage/repository.ts');

export async function testSharedClient({ userId, groupId, identity, cloud, anchor, key, bootstrap = false }) {
  const h = createDatabase(); const keys = new Map(); if (key) keys.set(1, key.slice());
  let record = { userId, groupId, status: bootstrap ? 'active' : 'joining', displayName: '共有テスト', anchor, rosterArchive: [],
    createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null };
  let roster;
  if ('body' in anchor) {
    roster = verifyPinnedSharedRoster(anchor, { groupId, digest: sharedRosterDigest(anchor), ownerUserId: anchor.body.ownerUserId, ownerIdentity: anchor.signer });
    record.rosterArchive = [anchor];
  }
  await initializeSharedProjection(h.database, { userId, groupId, householdId: repository.LOCAL_HOUSEHOLD_ID }); await initializeSharingLedger(h.database);
  const now = new Date('2026-10-27T02:00:00Z');
  const adapter = createSharedPlannerRepository(h.database, { userId, groupId, householdId: repository.LOCAL_HOUSEHOLD_ID, identity,
    now: () => now, makeId: randomUUID, roster: () => { if (!roster) throw new Error('not approved'); return roster; } });
  const unregister = registerSharedRepositoryAdapter(h.database, adapter);
  const deps = { database: h.database, userId, groupId, identity, crypto, cloud, readRecord: async () => record,
    saveArchive: async (archive) => { record = { ...record, rosterArchive: archive }; roster = archive.at(-1); },
    readKey: async (version) => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => { keys.set(version, value.slice()); },
    project: adapter.project, serialized: (work) => repository.withPlannerDatabaseOperation(h.database, work), changed: () => {} };
  const synchronizer = createSharedSynchronizer(deps);
  const sync = async (options = { force: true, budgetMs: 120000 }) => {
    const result = await synchronizer.sync(options); if (!result.waitingForApproval) record.status = 'active'; return result;
  };
  const manager = createSharedGroupManager({ ...deps, sync: synchronizer.sync, makeId: randomUUID, markLeft: async () => { record.status = 'left'; } });
  if (bootstrap) await createLocalSharedOperations(h.database, { groupId, userId, deviceId: identity.deviceId, keyVersion: 1 },
    sharedGroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: '所有者', name: '暗号化された家族', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
    adapter.project, (operation) => signSharedOperation(operation, identity).authorSignature);
  return { ...h, repository, adapter, deps, sync, manager, keys, roster: () => roster, record: () => record,
    replica: () => loadSharedReplica(h.database, groupId), checkpoint: () => readSharingCheckpoint(h.database, groupId), snapshot: () => adapter.readSnapshot(now),
    close: () => { unregister(); h.connection.close(); } };
}
