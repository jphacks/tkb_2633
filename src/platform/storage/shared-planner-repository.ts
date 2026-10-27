import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleTaskStatusChange } from '../../features/google-sync/contracts.ts';
import { googleTaskImportAction, parseGoogleCompletedAt } from '../../features/google-sync/google-completion-policy.ts';
import { buildSharedPlannerSnapshot } from '../../features/sharing/planning.ts';
import { planSharedMutation, sharedCompletionDraft, sharedUndoDrafts } from '../../features/sharing/mutations.ts';
import type { SharedMutationContext } from '../../features/sharing/mutations.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { signSharedOperation } from '../../features/sharing/crypto.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { sharedAuthorIdentity, sharedRosterDigest } from '../../features/sharing/roster.ts';
import type { PlannerSnapshot } from './repository.ts';
import { createLocalSharedOperations, loadSharedReplica } from './sharing-ledger.ts';
import { cacheSharedScheduleIfCurrent, persistSharedProjection, readSharedPrivateSettings, sharedProjectionToken } from './sharing-projection.ts';
import type { SharedRepositoryAdapter } from './shared-repository-adapter.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';

/** Every DB handle is permanently bound to its Firebase account and group. */
export function createSharedPlannerRepository(database: SQLiteDatabase, options: {
  groupId: string; userId: string; householdId: string; identity: DeviceSecretIdentity;
  roster: () => VerifiedSharedRoster; makeId: () => string; now?: () => Date; afterCommit?: () => void; authorize?: () => void;
}): SharedRepositoryAdapter & { project: (transaction: SQLiteDatabase, replica: SharedReplica) => Promise<void> } {
  const clock = options.now ?? (() => new Date());
  let cached: { token: string; privateSettings: string; rosterDigest: string; snapshot: PlannerSnapshot } | undefined;
  function build(replica: SharedReplica, now: Date, privateSettings?: Parameters<typeof buildSharedPlannerSnapshot>[1]['privateSettings']) {
    return buildSharedPlannerSnapshot(replica, { householdId: options.householdId, now, privateSettings,
      activeMemberIds: options.roster().body.members.map((member) => member.userId) });
  }
  const project = async (transaction: SQLiteDatabase, replica: SharedReplica) => {
    await persistSharedProjection(transaction, replica, build(replica, clock()), { userId: options.userId });
  };
  return {
    groupId: options.groupId, userId: options.userId, project,
    async readSnapshot(now: Date): Promise<PlannerSnapshot> {
      options.authorize?.();
      const meta = await database.getFirstAsync<{ projection_token: string }>('SELECT projection_token FROM sharing_workspace_metadata WHERE singleton=1');
      const privateSettings = await readSharedPrivateSettings(database, options.householdId);
      options.authorize?.();
      const privateSignature = JSON.stringify(privateSettings); const rosterDigest = sharedRosterDigest(options.roster());
      if (cached && cached.token === meta?.projection_token && cached.privateSettings === privateSignature && cached.rosterDigest === rosterDigest
        && cached.snapshot.today === sharedLocalDate(now, cached.snapshot.timeZone!)) return cached.snapshot;
      for (let attempt = 0; attempt < 4; attempt++) {
        const replica = await loadSharedReplica(database, options.groupId);
        options.authorize?.();
        const snapshot = build(replica, now, privateSettings); const token = sharedProjectionToken(replica, snapshot);
        if (await cacheSharedScheduleIfCurrent(database, token, snapshot)) {
          options.authorize?.();
          cached = { token, privateSettings: privateSignature, rosterDigest, snapshot }; return snapshot;
        }
      }
      throw new Error('共有データが更新されています。もう一度開いてください。');
    },
    async mutate(kind, args) {
      options.authorize?.();
      const roster = options.roster(); const identity = options.identity;
      sharedAuthorIdentity(roster, options.userId, identity.deviceId, roster.body.keyVersion);
      let result: unknown; const googleOrigins = new Set<string>();
      const operations = await createLocalSharedOperations(database, { groupId: options.groupId, userId: options.userId,
        deviceId: identity.deviceId, keyVersion: roster.body.keyVersion }, async (transaction, replica) => {
        // Waiting for another SQLite writer may outlive the account/membership
        // that authorized this call. Check again inside the actual transaction.
        options.authorize?.();
        const now = clock(); const snapshot = build(replica, now);
        const context: SharedMutationContext = { replica, snapshot, userId: options.userId, now, makeId: options.makeId };
        if (kind !== 'importGoogleTaskChanges' && kind !== 'importGoogleTaskCompletions') {
          const plan = planSharedMutation(context, kind, args); result = plan.result; return plan.drafts;
        }
        const changes = (args[0] as GoogleTaskStatusChange[]).map((item) => kind === 'importGoogleTaskCompletions' ? { ...item, status: 'completed' as const } : item);
        const links = await transaction.getAllAsync<{ schedule_entry_id: string; chore_id: string; google_task_list_id: string;
          google_task_id: string; pending_status: string | null; last_synced_status: string | null; last_synced_due_date: string | null }>(
          'SELECT schedule_entry_id, chore_id, google_task_list_id, google_task_id, pending_status, last_synced_status, last_synced_due_date FROM google_task_links WHERE household_id=?', options.householdId);
        const linkMap = new Map(links.map((item) => [JSON.stringify([item.google_task_list_id, item.google_task_id]), item]));
        const drafts = []; const seen = new Set<string>(); let count = 0;
        for (const change of changes) {
          const link = linkMap.get(JSON.stringify([change.googleTaskListId, change.googleTaskId]));
          if (!link || link.schedule_entry_id !== change.scheduleEntryId || seen.has(link.schedule_entry_id)
            || !snapshot.chores.some((item) => item.id === link.chore_id)) continue;
          const current = snapshot.completions.find((item) => item.scheduleEntryId === link.schedule_entry_id);
          const action = googleTaskImportAction({ pendingStatus: link.pending_status, lastSyncedStatus: link.last_synced_status }, current?.outcome, change.status);
          if (action === 'complete' && change.status === 'completed') {
            const timestamp = parseGoogleCompletedAt('completedAt' in change ? change.completedAt : undefined); if (!timestamp) continue;
            const saved = snapshot.scheduleEntries.find((item) => item.id === link.schedule_entry_id);
            drafts.push(sharedCompletionDraft(context, saved ?? { id: link.schedule_entry_id, choreId: link.chore_id,
              ...(link.last_synced_due_date ? { suggestedDate: link.last_synced_due_date as NonNullable<typeof saved>['suggestedDate'] } : {}) }, 'completed', timestamp));
          } else if (action === 'undo') drafts.push(...sharedUndoDrafts(context, link.schedule_entry_id));
          else continue;
          seen.add(link.schedule_entry_id); googleOrigins.add(link.schedule_entry_id); count++;
        }
        result = count; return drafts;
      }, async (transaction, replica) => {
        options.authorize?.();
        await persistSharedProjection(transaction, replica, build(replica, clock()), { userId: options.userId, importedGoogleOccurrenceIds: googleOrigins });
        options.authorize?.();
      }, (op) => signSharedOperation(op, identity).authorSignature);
      // Network errors belong to the delivery status, never to an already committed local edit.
      if (operations.length) options.afterCommit?.();
      return result;
    },
  };
}
