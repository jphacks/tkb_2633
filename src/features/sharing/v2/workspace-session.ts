import { createV2EventRepository, initializeV2EventStore } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedSyncDependencies } from '../synchronizer.ts';
import { createSharedGroupManager } from '../group-manager.ts';
import { SharingAccessError, SharingSchedulerVersionError } from '../cloud-contract.ts';
import { sharedWorkspaceProtocol, verifyWorkspaceArchive } from '../workspace-protocol.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { createV2GroupController } from './controller.ts';
import { createV2Synchronizer } from './synchronizer.ts';
import { v2GroupBootstrap } from './bootstrap.ts';
import type { GroupKind } from './model.ts';

export class V2WorkspaceMigrationRequiredError extends Error {
  readonly code = 'sharing/v2-migration-required';
  constructor() { super('旧グループを保持したまま、所有者が確認した移行データを準備する必要があります。'); }
}

/** This factory cannot receive a private/v1 planner adapter or invent server receipts. */
export async function createV2WorkspaceSession(deps: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  householdId: string; archive: () => readonly VerifiedSharedRoster[]; assertCurrentAccount: () => void;
  assertWritable: () => void; makeId: () => string; markLeft: () => Promise<void>; afterCommit?: () => void;
  creationKind?: GroupKind;
}) {
  const { householdId, archive, assertCurrentAccount, assertWritable, makeId, markLeft, afterCommit, creationKind, ...transport } = deps;
  assertCurrentAccount(); const record = await deps.readRecord(); assertCurrentAccount();
  if (record.userId !== deps.userId || record.groupId !== deps.groupId || ['left', 'removed'].includes(record.status)) throw new SharingAccessError('共有グループの利用状態を確認してください。');
  const verified = verifyWorkspaceArchive(record);
  if (!verified || sharedWorkspaceProtocol(verified.at(-1)!) !== 2) throw new SharingSchedulerVersionError();
  // A protocol transition alone is not evidence that its legacy business history was migrated.
  if (verified.some((roster) => roster.body.schemaVersion !== 2)) throw new V2WorkspaceMigrationRequiredError();
  if (record.status === 'creating' && (!record.creation || !['family', 'roommates'].includes(creationKind ?? ''))) throw new Error('新しい共有グループの種類を確認してください。');
  assertCurrentAccount(); assertWritable();
  const scope = { userId: deps.userId, groupId: deps.groupId, householdId };
  await initializeV2EventStore(deps.database, scope); assertCurrentAccount(); assertWritable();
  const repository = createV2EventRepository(deps.database, { ...scope, identity: deps.identity, anchor: verified[0], archive,
    assertWritable: () => { assertCurrentAccount(); assertWritable(); }, now: () => new Date((deps.now ?? Date.now)()), afterCommit });
  const synchronizer = createV2Synchronizer({ ...transport, repository, assertCurrentAccount });
  const manager = createSharedGroupManager({ ...transport, project: repository.project, sync: synchronizer.sync,
    verifyMembership: synchronizer.verifyMembership, makeId, markLeft: async () => { assertCurrentAccount(); await markLeft(); assertCurrentAccount(); } });
  const controller = createV2GroupController(repository, { makeId, now: () => new Date((deps.now ?? Date.now)()), sync: () => synchronizer.sync({ force: true }) });
  if (record.status === 'creating') {
    const creation = record.creation!;
    // Deterministic bootstrap operation IDs recover a crash without duplicating catalog entries.
    await repository.commit(v2GroupBootstrap({ groupId: deps.groupId, ownerUserId: deps.userId, ownerDisplayName: creation.ownerDisplayName,
      name: record.displayName, timeZone: creation.timeZone, anchorDate: creation.anchorDate as Parameters<typeof v2GroupBootstrap>[0]['anchorDate'], kind: creationKind! }));
  }
  return { repository, synchronizer, manager, controller };
}
export type V2WorkspaceSession = Awaited<ReturnType<typeof createV2WorkspaceSession>>;
