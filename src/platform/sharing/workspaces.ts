import { randomUUID } from 'expo-crypto';
import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { User } from 'firebase/auth';
import { getSharingServices, isSharingConfigured } from './firebase-services.ts';
import { nativeSharingCrypto } from './native-crypto.ts';
import { loadOrCreateSharingDeviceIdentity, loadSharingGroupKey, saveSharingGroupKey, sharingSecureVault } from './secure-store.ts';
import { openSharingDatabase, sharingDatabaseDirectory } from './database-location.ts';
import { createSharingCloud } from './firestore-cloud.ts';
import { createSharedRoster, sharedRosterDigest, verifyPinnedSharedRoster, verifySharedRosterArchive } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { planSharedConflictResolution } from '../../features/sharing/conflict-resolution.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { SharedEntityType } from '../../features/sharing/operations.ts';
import { signSharedOperation, wrapGroupKey } from '../../features/sharing/crypto.ts';
import { createSharedSynchronizer } from '../../features/sharing/synchronizer.ts';
import type { SharedSyncDependencies, SharingSyncResult } from '../../features/sharing/synchronizer.ts';
import { createSharedGroupManager } from '../../features/sharing/group-manager.ts';
import { sharedAccessDisposition } from '../../features/sharing/access-state.ts';
import { createSharedJoinRequest, parseSharedInvitation } from '../../features/sharing/invitations.ts';
import { isSharedTimeZone, sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { decodeSharingSelection, encodeSharingSelection } from '../../features/sharing/workspace-selection.ts';
import type { SharingSelection } from '../../features/sharing/workspace-selection.ts';
import { sharedGroupBootstrap } from '../../features/sharing/planning.ts';
import { SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError } from '../../features/sharing/cloud-contract.ts';
import { initializeSharingRegistry, listSharingWorkspaces, readSharingWorkspace, saveSharingWorkspace, updateSharingWorkspace } from '../storage/sharing-registry.ts';
import type { SharingWorkspaceRecord } from '../storage/sharing-registry.ts';
import { initializeSharedProjection } from '../storage/sharing-projection.ts';
import { createLocalSharedOperations, initializeSharingLedger, loadSharedReplica, readSharingCheckpoint } from '../storage/sharing-ledger.ts';
import { createSharedPlannerRepository } from '../storage/shared-planner-repository.ts';
import { registerSharedRepositoryAdapter, sharedRepositoryAdapter } from '../storage/shared-repository-adapter.ts';
import { drainPlannerDatabaseOperations, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID, withPlannerDatabaseOperation } from '../storage/repository.ts';

export type { SharingSelection } from '../../features/sharing/workspace-selection.ts';
type Listener = (selection?: SharingSelection) => void;
const listeners = new Set<Listener>();
export function subscribeSharingChanges(listener: Listener): () => void { listeners.add(listener); return () => { listeners.delete(listener); }; }
function changed(selection?: SharingSelection) { for (const listener of listeners) try { listener(selection); } catch { /* A view cannot invalidate a committed edit. */ } }
const keyForScope = (selection: SharingSelection) => canonicalJson([selection.userId, selection.groupId]);
let registryPromise: Promise<SQLiteDatabase> | null = null;
export function sharingRegistryDatabase(): Promise<SQLiteDatabase> {
  if (!registryPromise) {
    const pending = (async () => { const db = await openDatabaseAsync('sharing-index.db', { useNewConnection: true }, await sharingDatabaseDirectory());
      try { await initializeSharingRegistry(db); return db; }
      catch (error) { await db.closeAsync().catch(() => undefined); throw error; }
    })(); registryPromise = pending;
    void pending.catch(() => { if (registryPromise === pending) registryPromise = null; });
  }
  return registryPromise;
}
export async function sharingSessionUser(): Promise<User | null> {
  if (!isSharingConfigured()) return null;
  const auth = getSharingServices().auth; await auth.authStateReady(); return auth.currentUser;
}
export async function enableSharingSession(): Promise<void> { await sharingSecureVault.setItem('sharing-enabled', 'true'); }
export async function hasSharingSessionEnabled(): Promise<boolean> { return await sharingSecureVault.getItem('sharing-enabled') === 'true'; }
async function requireUser(): Promise<User> {
  const user = await sharingSessionUser(); if (!user) throw new SharingAccessError('共有グループ用のアカウントでログインしてください。'); return user;
}
export async function readSharingSelection(): Promise<SharingSelection | null> {
  const saved = await sharingSecureVault.getItem('active-workspace'); if (!saved) return null;
  return decodeSharingSelection(saved);
}
export async function saveSharingSelection(selection: SharingSelection | null): Promise<void> {
  if (!selection) await sharingSecureVault.removeItem('active-workspace');
  else {
    const user = await requireUser(); if (user.uid !== selection.userId) throw new SharingAccessError('共有アカウントが一致しません。');
    const workspace = await openSharedWorkspace(selection); const record = await workspace.record();
    if (!['active', 'creating'].includes(record.status)) throw new SharingAccessError('参加承認を完了してから切り替えてください。');
    await workspace.adapter.readSnapshot(new Date()); await drainPlannerDatabaseOperations(workspace.database);
    await sharingSecureVault.setItem('active-workspace', encodeSharingSelection(selection));
  }
  changed();
}
export async function knownSharingWorkspaces(): Promise<SharingWorkspaceRecord[]> {
  const user = await sharingSessionUser(); if (!user) return [];
  return listSharingWorkspaces(await sharingRegistryDatabase(), user.uid);
}
export function sharingFailureMessage(error: unknown): string {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  const name = error && typeof error === 'object' && 'name' in error ? String(error.name) : '';
  if (name === 'GoogleAuthorizationCancelledError') return 'Googleログインを完了してから、もう一度お試しください。';
  if (code === 'auth/network-request-failed' || code === 'unavailable') return '通信できません。接続を確認して、もう一度お試しください。端末内の変更は保持しています。';
  if (code === 'permission-denied' || code === 'sharing/access-denied') return '参加状態またはログインを確認してください。端末内の変更は保持しています。';
  if (code === 'resource-exhausted') return '共有先の利用上限に達しました。時間をおいて再送します。';
  if (code === 'unauthenticated' || code.startsWith('auth/')) return '共有アカウントでログインし直してください。';
  if (code === 'sharing/key-version-changed') return '共有鍵の更新を待っています。所有者の端末で同期してください。';
  if (code === 'sharing/scheduler-version-mismatch') return 'この共有グループの計算ルールに対応するLiFlowへ更新してください。';
  return '同期を完了できませんでした。端末内の変更は保持し、再送します。';
}

const workspacePromises = new Map<string, Promise<Awaited<ReturnType<typeof buildWorkspace>>>>();
export function openSharedWorkspace(selection: SharingSelection) {
  const key = keyForScope(selection); let promise = workspacePromises.get(key);
  if (!promise) { promise = buildWorkspace(selection); workspacePromises.set(key, promise);
    const pending = promise; void pending.catch(() => { if (workspacePromises.get(key) === pending) workspacePromises.delete(key); }); }
  return promise;
}
export type SharedWorkspace = Awaited<ReturnType<typeof openSharedWorkspace>>;
async function buildWorkspace(selection: SharingSelection) {
  const user = await requireUser(); if (user.uid !== selection.userId) throw new SharingAccessError('共有アカウントが切り替わりました。');
  const registry = await sharingRegistryDatabase(); const { userId, groupId } = selection;
  let record = await readSharingWorkspace(registry, userId, groupId); if (!record) throw new Error('共有グループが見つかりません。');
  const generation = record.localGeneration;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, generation); let roster: VerifiedSharedRoster | undefined;
  if ('body' in record.anchor) {
    const pin = record.anchor; const anchor = verifyPinnedSharedRoster(pin, { groupId, digest: sharedRosterDigest(pin), ownerUserId: pin.body.ownerUserId, ownerIdentity: pin.signer });
    roster = record.rosterArchive.length ? verifySharedRosterArchive(anchor, record.rosterArchive).at(-1) : anchor;
  } else if (record.rosterArchive.length) {
    const anchor = verifyPinnedSharedRoster(record.rosterArchive[record.anchor.revision - 1], record.anchor);
    roster = verifySharedRosterArchive(anchor, record.rosterArchive).at(-1);
  }
  const database = await openSharingDatabase(userId, groupId, generation);
  let unregister: (() => void) | undefined;
  try {
    await initializeSharedProjection(database, { ...selection, householdId: LOCAL_HOUSEHOLD_ID }); await initializeSharingLedger(database);
    const cloud = createSharingCloud(getSharingServices().firestore, userId, () => getSharingServices().auth.currentUser?.uid ?? null);
    const assertGeneration = (current: SharingWorkspaceRecord) => { if (current.localGeneration !== generation) throw new SharingAccessError('再参加前のデータは読み取り専用で保持されています。'); };
    const readRecord = async () => { const latest = await readSharingWorkspace(registry, userId, groupId); if (!latest) throw new Error('共有グループが見つかりません。'); assertGeneration(latest); record = latest; return latest; };
    const update = async (change: (prior: SharingWorkspaceRecord) => SharingWorkspaceRecord) => { record = await updateSharingWorkspace(registry, userId, groupId, (prior) => { assertGeneration(prior); return change(prior); }); changed(selection); return record; };
    let sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<SharingSyncResult>;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    const authorize = () => {
      if (record) assertGeneration(record);
      if (record?.lastErrorCode === 'sharing/scheduler-version-mismatch') throw new SharingSchedulerVersionError();
      if (record && ['sharing/access-denied', 'permission-denied'].includes(record.lastErrorCode ?? '')) throw new SharingAccessError('共有グループの参加状態を同期して確認してください。');
      if (getSharingServices().auth.currentUser?.uid !== userId || !record || !['active', 'creating'].includes(record.status)) throw new SharingAccessError('この共有グループは現在編集できません。');
    };
    const adapter = createSharedPlannerRepository(database, { ...selection, householdId: LOCAL_HOUSEHOLD_ID, identity, makeId: randomUUID,
      roster: () => { if (!roster) throw new Error('参加承認と初回同期を完了してください。'); return roster; }, authorize,
      afterCommit: () => { changed(selection); clearTimeout(debounce); debounce = setTimeout(() => { void sync().catch(() => undefined); }, 350); } });
    // A process may stop after saving its create intent. Bootstrap IDs make this recovery idempotent.
    if (record.status === 'creating' && record.creation) {
      const creation = record.creation;
      await createLocalSharedOperations(database, { groupId, userId, deviceId: identity.deviceId, keyVersion: 1 },
        sharedGroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: creation.ownerDisplayName, name: record.displayName,
          timeZone: creation.timeZone, anchorDate: creation.anchorDate as Parameters<typeof sharedGroupBootstrap>[0]['anchorDate'] }),
        adapter.project, (operation) => signSharedOperation(operation, identity).authorSignature);
    }
    unregister = registerSharedRepositoryAdapter(database, adapter);
    const deps: SharedSyncDependencies = { ...selection, database, identity, crypto: nativeSharingCrypto, cloud, readRecord,
      saveArchive: async (archive) => {
        const next = archive.at(-1)!;
        record = await updateSharingWorkspace(registry, userId, groupId, (previous) => {
          assertGeneration(previous);
          if ((previous.rosterArchive.at(-1)?.body.revision ?? 0) > next.body.revision) throw new Error('Membership changed concurrently');
          return { ...previous, rosterArchive: archive };
        }); roster = next;
      },
      readKey: (version) => loadSharingGroupKey(userId, groupId, version), saveKey: (version, bytes) => saveSharingGroupKey(userId, groupId, version, bytes),
      project: adapter.project, serialized: (work) => withPlannerDatabaseOperation(database, work), changed: () => changed(selection) };
    const synchronizer = createSharedSynchronizer(deps);
    const manager = createSharedGroupManager({ ...deps, sync: (options) => synchronizer.sync(options), makeId: randomUUID,
      markLeft: async () => { await update((previous) => ({ ...previous, status: 'left', lastErrorCode: null })); } });
    let serviceRun: Promise<SharingSyncResult> | null = null; let runRequested = false; let forceRequested = false;
    sync = (options = {}) => {
      if (serviceRun) { runRequested = true; forceRequested ||= Boolean(options.force); return serviceRun; }
      const pending = (async () => {
        try {
          const current = await readRecord();
          if (['left', 'removed'].includes(current.status)) throw new SharingAccessError('このグループからは退出済みです。');
          if (current.status === 'creating') {
            if (!current.creation || !roster) throw new Error('作成途中の共有グループを復旧できません。');
            await cloud.createGroup(roster, current.creation.wrappedKey); await update((previous) => ({ ...previous, status: 'active' }));
          } else if (current.status === 'joining') {
            if (!current.join) throw new Error('参加要求が見つかりません。');
            try { await cloud.submitJoinRequest(current.join.invitation, current.join.request); }
            catch (error) {
              // An approval may have atomically consumed the invitation while the app was closed.
              const actual = await cloud.readInvitation(current.join.invitation.body.inviteId);
              if (actual.status !== 'used' || actual.usedBy !== userId) throw error;
            }
          }
          let result;
          try { result = await synchronizer.sync(options); }
          catch (error) {
            if (!(error instanceof SharingKeyVersionError) || roster?.body.ownerDeviceId !== identity.deviceId) throw error;
            await manager.repairDepartures(); result = await synchronizer.sync(options);
          }
          if (!result.waitingForApproval) {
            const replica = await loadSharedReplica(database, groupId);
            if (!replica.entities.some((entity) => entity.entityType === 'member' && entity.entityId === `member:${userId}`)) {
              await createLocalSharedOperations(database, { groupId, userId, deviceId: identity.deviceId, keyVersion: roster!.body.keyVersion },
                [{ operationId: randomUUID(), entityType: 'member', entityId: `member:${userId}`, operationType: 'patch', payload: { userId, displayName: user.displayName?.trim() || 'メンバー' } }],
                adapter.project, (operation) => signSharedOperation(operation, identity).authorSignature);
              result = await synchronizer.sync({ ...options, force: true });
            }
            const name = replica.entities.find((entity) => entity.entityType === 'settings' && entity.entityId === 'settings')?.fields.name;
            await update((previous) => ({ ...previous, status: 'active', displayName: typeof name === 'string' ? name : previous.displayName,
              lastSuccessfulSyncAt: Date.now(), lastErrorCode: null }));
          }
          return result;
        } catch (error) {
          const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : 'sharing/failed';
          const disposition = sharedAccessDisposition({ errorCode: code, currentAccountUserId: getSharingServices().auth.currentUser?.uid ?? null,
            userId, deviceId: identity.deviceId, status: record?.status, roster });
          let removed = disposition === 'removed';
          if (disposition === 'check-membership') {
            try { removed = !await cloud.hasMembership(groupId); } catch { /* A network error does not prove removal. */ }
          }
          await update((previous) => ({ ...previous, ...(removed ? { status: 'removed' as const } : {}), lastErrorCode: code })).catch(() => undefined); throw error;
        }
      })(); serviceRun = pending;
      void pending.finally(() => {
        if (serviceRun === pending) serviceRun = null; changed(selection);
        if (runRequested) { const force = forceRequested; runRequested = false; forceRequested = false;
          setTimeout(() => { void sync({ force }).catch(() => undefined); }, 0); }
      }).catch(() => undefined); return pending;
    };
    return { ...selection, database, adapter, cloud, identity, manager, sync, record: readRecord,
      roster: () => roster, checkpoint: () => readSharingCheckpoint(database, groupId), watch: (callback: () => void, failed: (error: unknown) => void) => cloud.watch(groupId, callback, failed),
      async cancelJoinRequest() {
        const prior = await readRecord(); if (prior.status !== 'joining' || !prior.join) throw new Error('参加申請が見つかりません。');
        const cancelled = await cloud.cancelOwnJoinRequest(prior.join.invitation, prior.join.request);
        if (!cancelled) throw new Error('参加は承認済みです。同期してからメンバー・端末の管理で解除してください。');
        await update((previous) => ({ ...previous, status: 'left', lastErrorCode: null }));
      },
      async maintainHistory() {
        if (roster?.body.ownerDeviceId !== identity.deviceId || record?.status !== 'active') return;
        const { group } = await cloud.readGroup(groupId);
        if (group.rotationRequired) return;
        if (group.headSequence - group.snapshotThroughSequence >= 256) await manager.publishSnapshot();
        await cloud.compactHistory(groupId);
      },
      async resolveConflict(entityType: SharedEntityType, entityId: string, field: string, candidateId: string) {
        authorize(); const current = roster!;
        await withPlannerDatabaseOperation(database, () => createLocalSharedOperations(database,
          { groupId, userId, deviceId: identity.deviceId, keyVersion: current.body.keyVersion }, async (_transaction, replica) => {
            authorize();
            return [planSharedConflictResolution(replica, entityType, entityId, field, candidateId, randomUUID())];
          }, async (transaction, replica) => {
            authorize(); await adapter.project(transaction, replica); authorize();
          }, (operation) => signSharedOperation(operation, identity).authorSignature));
        changed(selection); void sync({ force: true }).catch(() => undefined);
      } };
  } catch (error) {
    unregister?.();
    await database.closeAsync().catch(() => undefined);
    throw error;
  }
}

export async function createSharingWorkspace(name: string, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone): Promise<SharedWorkspace> {
  const trimmed = name.trim(); if (!trimmed || trimmed.length > 100) throw new Error('グループ名は1〜100文字で入力してください。');
  if (!isSharedTimeZone(timeZone)) throw new Error('共有するタイムゾーンを確認してください。');
  const user = await requireUser(); const groupId = `group.${randomUUID()}`; const userId = user.uid; const registry = await sharingRegistryDatabase();
  const identity = await loadOrCreateSharingDeviceIdentity(userId); const roster = createSharedRoster(groupId, userId, identity); const key = await nativeSharingCrypto.randomBytes(32);
  const now = new Date();
  try {
    const wrappedKey = await wrapGroupKey(nativeSharingCrypto, groupId, 1, key, identity, identity, userId);
    await saveSharingGroupKey(userId, groupId, 1, key);
    const creation = { wrappedKey, timeZone, anchorDate: sharedLocalDate(now, timeZone), ownerDisplayName: user.displayName?.trim() || '自分' };
    await saveSharingWorkspace(registry, { userId, groupId, displayName: trimmed, status: 'creating', anchor: roster, rosterArchive: [roster],
      createdAt: now.toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null, creation });
    const workspace = await openSharedWorkspace({ userId, groupId });
    await enableSharingSession(); changed({ userId, groupId });
    void import('../../features/google-sync/background-task').then((module) => module.registerGoogleSyncBackgroundTask()).catch(() => undefined);
    void workspace.sync().catch(() => undefined); return workspace;
  } finally { key.fill(0); }
}

export async function requestSharingWorkspace(linkText: string): Promise<SharedWorkspace> {
  const link = parseSharedInvitation(linkText.trim(), Date.now()); const user = await requireUser(); const userId = user.uid;
  const groupId = link.invitation.body.groupId;
  const registry = await sharingRegistryDatabase(); const old = await readSharingWorkspace(registry, userId, groupId);
  const rejoining = old && ['left', 'removed'].includes(old.status);
  const generation = rejoining ? randomUUID() : old?.localGeneration;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, generation);
  const request = createSharedJoinRequest(link, userId, identity, Date.now());
  if (old) {
    const pin = 'body' in old.anchor ? sharedRosterDigest(old.anchor) : old.anchor.digest;
    // A new invitation may pin a later verified epoch, but cannot replace a previously trusted chain silently.
    if (pin !== link.invitation.body.pin.digest && !old.rosterArchive.some((item) => sharedRosterDigest(item) === link.invitation.body.pin.digest)
      && link.invitation.body.pin.revision <= old.rosterArchive.length) throw new Error('以前の共有グループと招待の確認情報が一致しません。');
    if (['active', 'creating'].includes(old.status)) return openSharedWorkspace({ userId, groupId });
    await updateSharingWorkspace(registry, userId, groupId, (previous) => {
      if (previous.status !== old.status || previous.localGeneration !== old.localGeneration) throw new Error('参加状態が変わりました。画面を開き直してください。');
      return { ...previous, status: 'joining', join: { invitation: link.invitation, request }, lastErrorCode: null,
        ...(rejoining ? { localGeneration: generation, archivedLocalGenerations: [...new Set([...(previous.archivedLocalGenerations ?? []), previous.localGeneration ?? 'initial'])] } : {}) };
    });
    if (rejoining) workspacePromises.delete(keyForScope({ userId, groupId }));
  } else await saveSharingWorkspace(registry, { userId, groupId, displayName: '参加を申請したグループ', status: 'joining', anchor: link.invitation.body.pin, rosterArchive: [],
    createdAt: new Date().toISOString(), lastSuccessfulSyncAt: null, lastErrorCode: null, join: { invitation: link.invitation, request } });
  const workspace = await openSharedWorkspace({ userId, groupId }); await enableSharingSession(); changed({ userId, groupId });
  void import('../../features/google-sync/background-task').then((module) => module.registerGoogleSyncBackgroundTask()).catch(() => undefined);
  await workspace.sync({ force: true }); return workspace;
}

/** Foreground and the single OS worker call the same bounded coordinator. */
export async function syncKnownSharingWorkspaces(budgetMs = 20_000): Promise<void> {
  if (!await hasSharingSessionEnabled()) return;
  const start = Date.now(); const records = await knownSharingWorkspaces();
  const failures: unknown[] = [];
  for (const record of records.filter((item) => !['left', 'removed'].includes(item.status))) {
    const remaining = budgetMs - (Date.now() - start); if (remaining < 1000) break;
    try {
      const workspace = await openSharedWorkspace(record);
      const syncBudget = budgetMs - (Date.now() - start); if (syncBudget < 1000) break;
      await workspace.sync({ budgetMs: syncBudget }).catch(() => undefined);
      if (Date.now() - start < budgetMs - 5000) await workspace.maintainHistory().catch(() => undefined);
      if (budgetMs - (Date.now() - start) < 1000) continue;
      const state = await loadGoogleSyncState(workspace.database);
      if (state?.enabled && budgetMs - (Date.now() - start) >= 1000) {
        const { syncGoogleTasks } = await import('../../features/google-sync/coordinator');
        await syncGoogleTasks(workspace.database).catch(() => undefined);
      }
    } catch (error) { failures.push(error); }
  }
  if (budgetMs - (Date.now() - start) >= 1000) try {
    const selection = await readSharingSelection();
    if (selection && records.some((record) => record.userId === selection.userId && record.groupId === selection.groupId && record.status === 'active')) {
      const workspace = await openSharedWorkspace(selection); const snapshot = await workspace.adapter.readSnapshot(new Date());
      const { syncDailyHouseworkDigest } = await import('../../features/notifications/daily-housework-digest');
      const { expoLocalNotificationGateway } = await import('../notifications/expo-local-notification-gateway');
      const { sharedGoogleNamespace } = await import('../../features/google-sync/workspace-policy');
      await syncDailyHouseworkDigest(expoLocalNotificationGateway, { ...snapshot, notificationScope: sharedGoogleNamespace(selection.userId, selection.groupId),
        notificationTitle: `${snapshot.household.name}の家事` }).catch(() => undefined);
    }
  } catch (error) { failures.push(error); }
  // A broken workspace cannot starve unrelated groups, but the worker must still
  // observe the original storage failure after those groups have had a chance.
  if (failures.length) throw failures[0];
}

/** Native OAuth is shared by the process, while connection settings and Task IDs remain per workspace. */
export async function hasOtherGoogleWorkspaceConnections(except: SQLiteDatabase): Promise<boolean> {
  if (sharedRepositoryAdapter(except)) {
    const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
    try { const state = await loadGoogleSyncState(personal); if (state && !state.disconnected && (state.accountSubject || state.taskListId || state.enabled)) return true; }
    finally { await personal.closeAsync(); }
  }
  if (!await hasSharingSessionEnabled()) return false;
  for (const record of (await knownSharingWorkspaces()).filter((record) => !['left', 'removed'].includes(record.status))) {
    const workspace = await openSharedWorkspace(record); if (workspace.database === except) continue;
    const state = await loadGoogleSyncState(workspace.database);
    if (state && !state.disconnected && (state.accountSubject || state.taskListId || state.enabled)) return true;
  }
  return false;
}

export async function isSharedWorkerNeeded(): Promise<boolean> {
  return await hasSharingSessionEnabled() && (await knownSharingWorkspaces()).some((record) => !['left', 'removed'].includes(record.status));
}
