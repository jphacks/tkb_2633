import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(options = {}) {
  const events = []; const handles = []; const synchronizers = []; const syncBudgets = [];
  const session = { userId: 'member' };
  const records = (options.groups ?? ['broken', 'healthy']).map((groupId) => ({ userId: 'member', groupId,
    status: 'active', displayName: groupId, rosterArchive: [], anchor: { body: { groupId, ownerDeviceId: 'another-device',
      members: [{ userId: 'member', devices: [{ identity: { deviceId: 'this-device' } }] }] } } }));
  const registry = { closeAsync: async () => { events.push('registry-close'); } };
  const api = loadNativeModule('src/platform/sharing/workspaces.ts', {
    'expo-crypto': { randomUUID: () => 'test-operation' },
    'expo-sqlite': { openDatabaseAsync: async () => registry },
    './firebase-services.ts': { isSharingConfigured: () => true,
      getSharingServices: () => ({ auth: { authStateReady: async () => {}, currentUser: { uid: session.userId } }, firestore: {} }) },
    './native-crypto.ts': { nativeSharingCrypto: {} },
    './secure-store.ts': { loadOrCreateSharingDeviceIdentity: async () => ({ deviceId: 'this-device' }),
      sharingSecureVault: { getItem: async (key) => key === 'sharing-enabled' ? 'true' : options.selection ? JSON.stringify(options.selection) : null } },
    './database-location.ts': { sharingDatabaseDirectory: async () => '/protected-test-directory',
      openSharingDatabase: async (_userId, groupId) => {
        events.push(`open:${groupId}`);
        if (options.failOpen === groupId) throw new Error(`open failed:${groupId}`);
        options.afterOpen?.(groupId);
        const database = { groupId, closeAsync: async () => { events.push(`close:${groupId}`); } };
        handles.push(database); return database;
      } },
    './firestore-cloud.ts': { createSharingCloud: () => ({}) },
    '../../features/sharing/roster.ts': { sharedRosterDigest: () => 'test-digest', verifyPinnedSharedRoster: (roster) => roster },
    '../../features/sharing/operations.ts': { canonicalJson: JSON.stringify },
    '../../features/sharing/workspace-protocol.ts': { verifyWorkspaceArchive: (record) => [record.anchor], sharedWorkspaceProtocol: () => 1 },
    '../../features/sharing/v2/workspace-session.ts': {}, '../../features/sharing/v2/view-point.ts': {},
    '../../features/sharing/v2/controller-access.ts': {},
    '../../features/sharing/crypto.ts': {},
    '../../features/sharing/conflict-resolution.ts': { planSharedConflictResolution: () => {
      events.push('resolve-plan'); return { operationId: 'resolution', entityType: 'waste', entityId: 'waste', operationType: 'patch', payload: { label: '缶' } };
    } },
    '../../features/sharing/synchronizer.ts': { createSharedSynchronizer: (deps) => { synchronizers.push(deps); return { sync: async (runOptions) => {
      syncBudgets.push(runOptions.budgetMs);
      events.push(`sync:${deps.groupId}`); options.afterSync?.(deps.groupId);
      if (options.failSync === deps.groupId) throw new Error(`sync failed:${deps.groupId}`);
      return { waitingForApproval: true };
    } }; } },
    '../../features/sharing/group-manager.ts': { createSharedGroupManager: () => ({}) },
    '../../features/sharing/access-state.ts': { sharedAccessDisposition: () => 'retain' },
    '../../features/sharing/invitations.ts': {}, '../../features/sharing/group-clock.ts': {},
    '../../features/sharing/workspace-selection.ts': { decodeSharingSelection: JSON.parse },
    '../../features/sharing/planning.ts': {}, '../../features/sharing/cloud-contract.ts': {
      SharingKeyVersionError: class extends Error {}, SharingAccessError: class extends Error {}, SharingSchedulerVersionError: class extends Error {},
    },
    '../storage/sharing-registry.ts': {
      initializeSharingRegistry: async () => { if (options.failRegistry) throw new Error('registry initialization failed'); },
      readSharingWorkspace: async (_db, _user, groupId) => records.find((record) => record.groupId === groupId),
      listSharingWorkspaces: async () => records,
      updateSharingWorkspace: async (_db, _user, groupId, change) => {
        const index = records.findIndex((record) => record.groupId === groupId);
        const next = change(records[index]); records[index] = next; return next;
      },
    },
    '../storage/sharing-projection.ts': { initializeSharedProjection: async (db) => {
      events.push(`initialize:${db.groupId}`);
      if (options.failProjection === db.groupId) throw new Error(`projection failed:${db.groupId}`);
    } },
    '../storage/sharing-ledger.ts': { initializeSharingLedger: async () => {}, createLocalSharedOperations: async (database, _scope, plan, project) => {
      const replica = {}; const drafts = await plan(database, replica); await project(database, replica); return drafts;
    } },
    '../storage/shared-planner-repository.ts': { createSharedPlannerRepository: (_database, scope) => ({
      readSnapshot: async () => ({ household: { name: 'group' }, groupId: scope.groupId }),
      project: async () => { events.push('resolve-project'); options.afterProjection?.(); },
    }) },
    '../storage/shared-repository-adapter.ts': { registerSharedRepositoryAdapter: () => {} },
    '../storage/repository.ts': { LOCAL_HOUSEHOLD_ID: 'home', withPlannerDatabaseOperation: async (_database, work) => { await options.beforeQueuedWork?.(); return work(); }, loadGoogleSyncState: async (db) => {
      events.push(`google-state:${db.groupId}`);
      if (options.failGoogleState === db.groupId) throw new Error(`google state failed:${db.groupId}`);
      return { enabled: options.googleEnabled === true };
    } },
    '../../features/google-sync/coordinator': { syncGoogleTasks: async (db) => { events.push(`google-sync:${db.groupId}`); } },
    '../../features/notifications/daily-housework-digest': { syncDailyHouseworkDigest: async (_gateway, snapshot) => { events.push(`notify:${snapshot.groupId}`); } },
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: {} },
    '../../features/google-sync/workspace-policy': { sharedGoogleNamespace: () => 'a'.repeat(64) },
  });
  return { api, events, handles, records, synchronizers, syncBudgets, session };
}

test('conflict resolution waiting for the workspace writer cannot proceed after the sharing account changes', async () => {
  const options = { groups: ['healthy'] }; const h = fixture(options);
  const workspace = await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  options.beforeQueuedWork = () => { h.session.userId = 'another-account'; };
  await assert.rejects(workspace.resolveConflict('waste', 'waste', 'label', 'candidate'), /現在編集できません/);
  assert.equal(h.events.includes('resolve-plan'), false);
  assert.equal(h.events.includes('resolve-project'), false);
});

test('conflict resolution rechecks sharing access after its projection before the transaction may commit', async () => {
  const options = { groups: ['healthy'] }; const h = fixture(options);
  const workspace = await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  options.afterProjection = () => { h.session.userId = 'another-account'; };
  await assert.rejects(workspace.resolveConflict('waste', 'waste', 'label', 'candidate'), /現在編集できません/);
  assert.ok(h.events.includes('resolve-plan'));
  assert.ok(h.events.includes('resolve-project'));
});

test('one unavailable shared database does not prevent later groups or the selected group reminders from syncing', async () => {
  const h = fixture({ failOpen: 'broken', selection: { userId: 'member', groupId: 'healthy' } });
  await assert.rejects(h.api.syncKnownSharingWorkspaces(), /open failed:broken/);
  assert.ok(h.events.includes('sync:healthy'), 'a healthy group must not depend on an unrelated database opening');
  assert.ok(h.events.includes('notify:healthy'));
});

test('a private Google-state read failure is isolated to its group while the original error remains observable', async () => {
  const h = fixture({ failGoogleState: 'broken' });
  await assert.rejects(h.api.syncKnownSharingWorkspaces(), /google state failed:broken/);
  assert.ok(h.events.includes('sync:healthy'));
});

test('a durably reported shared sync failure still leaves other groups available', async () => {
  const h = fixture({ failSync: 'broken' });
  await h.api.syncKnownSharingWorkspaces();
  assert.ok(h.events.includes('sync:healthy'));
});

test('a shared worker does not start another Google phase after its time budget has already expired', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ googleEnabled: true, afterSync: () => { now += 30000; } });
    await h.api.syncKnownSharingWorkspaces(20000);
    assert.deepEqual(h.events.filter((event) => event.startsWith('sync:')), ['sync:broken']);
    assert.equal(h.events.some((event) => event.startsWith('google-state:')), false);
    assert.equal(h.events.some((event) => event.startsWith('google-sync:')), false);
  } finally { Date.now = originalNow; }
});

test('opening a shared database consumes the same worker budget instead of granting a fresh interval', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ groups: ['healthy'], afterOpen: () => { now += 7000; } });
    await h.api.syncKnownSharingWorkspaces(20000);
    assert.deepEqual(h.syncBudgets, [13000]);
  } finally { Date.now = originalNow; }
});

test('a database that finishes opening after the worker deadline does not start a cloud sync', async () => {
  const originalNow = Date.now; let now = 1000;
  Date.now = () => now;
  try {
    const h = fixture({ groups: ['healthy'], afterOpen: () => { now += 30000; } });
    await h.api.syncKnownSharingWorkspaces(20000);
    assert.deepEqual(h.syncBudgets, []);
    assert.equal(h.events.some((event) => event.startsWith('google-state:')), false);
  } finally { Date.now = originalNow; }
});

test('failed shared database initialization closes only its new handle and a retry can open a fresh connection', async () => {
  const h = fixture({ failProjection: 'broken' });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(h.api.openSharedWorkspace({ userId: 'member', groupId: 'broken' }), /projection failed/);
  assert.equal(h.handles.length, 2);
  assert.equal(h.events.filter((event) => event === 'close:broken').length, 2);
  assert.equal(h.events.includes('registry-close'), false, 'a group failure must not close a healthy shared registry');
});

test('failed sharing registry initialization releases its handle before retrying instead of leaking connections', async () => {
  const h = fixture({ failRegistry: true });
  for (let attempt = 0; attempt < 2; attempt++) await assert.rejects(h.api.sharingRegistryDatabase(), /registry initialization failed/);
  assert.equal(h.events.filter((event) => event === 'registry-close').length, 2);
});

test('a delayed roster result from an archived workspace cannot update a newly requested local generation', async () => {
  const h = fixture({ groups: ['healthy'] });
  await h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' });
  const rejoining = { ...h.records[0], status: 'joining', localGeneration: 'new-generation', archivedLocalGenerations: ['initial'] };
  h.records[0] = rejoining;
  await assert.rejects(h.synchronizers[0].saveArchive([{ body: { groupId: 'healthy', revision: 2 } }]), /再参加前/);
  assert.equal(h.records[0], rejoining);
  assert.equal(h.records[0].rosterArchive.length, 0);
});

test('a legacy workspace account switch during native database opening closes the new handle before schema initialization', async () => {
  const options = { groups: ['healthy'] }; const h = fixture(options);
  options.afterOpen = () => { h.session.userId = 'another-account'; };
  await assert.rejects(h.api.openSharedWorkspace({ userId: 'member', groupId: 'healthy' }), /切り替わり/u);
  assert.equal(h.events.includes('initialize:healthy'), false); assert.ok(h.events.includes('close:healthy'));
});
