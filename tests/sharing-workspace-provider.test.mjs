import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

test('active workspace scope never injects a legacy provider and preserves the personal database context', () => {
  for (const platform of ['ios', 'android']) for (const active of [null, { protocol: 1, userId: 'owner', groupId: 'legacy', database: { legacy: true } },
    { protocol: 2, userId: 'owner', groupId: 'v2', database: { v2: true } }]) {
    const mounted = [];
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'ActiveWorkspaceScope', props: { children: 'workspace-child' }, mocks: {
      '@/contexts/workspace-context': { WorkspaceContext: { _currentValue: { ready: true, active } } },
      './use-planner-data': { PlannerDataProvider: ({ databaseOverride, children }) => { mounted.push(databaseOverride); return children; } },
      '@/platform/sharing/private-calendar-sync': {},
      '@/platform/sharing/auth': {}, '@/platform/storage/repository': {},
    } });
    assert.deepEqual(mounted, []);
    assert.ok(screen.text().includes('workspace-child'));
  }
});

for (const platform of ['ios', 'android']) for (const registryBroken of [false, true]) {
  test(`${platform} foreground uses one timer for shared and private Calendar work and stops both after backgrounding even with registry failure=${registryBroken}`, async t => {
    const effects = []; const ticks = []; let stateListener; let privateStarts = 0; let privateStops = 0; let privateSyncs = 0; let sharedSyncs = 0;
    t.mock.method(globalThis, 'setInterval', (work, interval) => { assert.equal(interval, 600000); ticks.push(work); return ticks.length; });
    t.mock.method(globalThis, 'clearInterval', () => {});
    const appState = { currentState: 'active', addEventListener: (_event, listener) => { stateListener = listener; return { remove() {} }; } };
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) }, '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, 'react-native': { AppState: appState },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: userId => { assert.equal(userId, 'owner'); privateStarts++; return () => { privateStops++; }; }, syncKnownPrivateCalendar: async () => { privateSyncs++; } },
      '@/platform/sharing/workspaces': { readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true, sharingSessionUser: async () => ({ uid: 'owner' }),
        knownSharingWorkspaces: async () => { if (registryBroken) throw new Error('synthetic registry failure'); return []; },
        subscribeSharingChanges: () => () => {}, syncKnownSharingWorkspaces: async () => { sharedSyncs++; } },
    } });
    const disposeBoot = effects[0](); let disposeForeground;
    try {
      await screen.flush(); disposeForeground = effects.at(-1)(); await screen.flush();
      assert.equal(privateStarts, 1); assert.equal(privateSyncs, 1); assert.equal(sharedSyncs, 1); assert.equal(ticks.length, 1);
      ticks[0](); await screen.flush(); assert.equal(privateSyncs, 2); assert.equal(sharedSyncs, 2);
      appState.currentState = 'background'; stateListener('background'); ticks[0](); await screen.flush();
      assert.equal(privateStops, 1); assert.equal(privateSyncs, 2); assert.equal(sharedSyncs, 2);
      appState.currentState = 'active'; stateListener('active'); await screen.flush();
      assert.equal(privateStarts, 2); assert.equal(privateSyncs, 3); assert.equal(sharedSyncs, 3); assert.equal(ticks.length, 2);
    } finally { disposeForeground?.(); disposeBoot?.(); }
    assert.equal(privateStops, 2);
  });
}

for (const platform of ['ios', 'android']) {
  test(`${platform} workspace bootstrap rechecks the account after registry I/O before exposing groups or starting private work`, async () => {
    let currentUser = 'old-owner'; const effects = [];
    const group = { userId: 'new-owner', groupId: 'new-account-group', status: 'active' };
    const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: callback => effects.push(callback), mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) }, '@/platform/storage/repository': {},
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, '@/platform/sharing/private-calendar-sync': {},
      '@/platform/sharing/workspaces': { readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: currentUser }), knownSharingWorkspaces: async () => { currentUser = 'new-owner'; return [group]; }, subscribeSharingChanges: () => () => {} },
    } });
    const dispose = effects[0](); try { await screen.flush(); const value = screen.nodes().find(node => node.props.value?.ready === true)?.props.value;
      assert.ok(value); assert.equal(value.userId, 'new-owner'); assert.deepEqual(value.groups, [group]);
    } finally { dispose?.(); }
  });
}

for (const [platform, name] of [
  ['ios', 'ios foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
  ['android', 'android foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
]) test(name, async () => {
  const effects = []; const watches = []; const synchronizations = []; let unsubscribed = 0;
  const group = { userId: 'owner', groupId: 'group-test', status: 'active', displayName: '家族' };
  const workspace = { ...group, protocol: 1, database: {}, readOverview: async () => ({}), drain: async () => {}, adapter: { readSnapshot: async () => ({}) },
    watch: (changed, failed) => { watches.push({ changed, failed }); return () => { unsubscribed++; }; },
    async sync() { synchronizations.push('membership-check'); throw new Error('synthetic unavailable or permission-denied'); } };
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {},
      '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} },
      'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        readSharingSelection: async () => ({ userId: group.userId, groupId: group.groupId }), hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), knownSharingWorkspaces: async () => [group],
        openSharedWorkspace: async () => workspace, subscribeSharingChanges: () => () => {}, syncKnownSharingWorkspaces: async () => {},
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush();
    disposeForeground = effects.at(-1)();
    await screen.flush();
    assert.equal(watches.length, 1);
    watches[0].failed({ code: 'permission-denied' });
    await screen.flush();
    assert.deepEqual(synchronizations, ['membership-check']);
    watches[0].failed({ code: 'unavailable' });
    watches[0].changed();
    await screen.flush();
    assert.equal(synchronizations.length, 3, 'both successful updates and terminated listeners use the same existing coordinator');
  } finally { disposeForeground?.(); disposeBoot?.(); }
  assert.equal(unsubscribed, 1);
});

for (const [platform, groupIds, name] of [
  ['ios', ['broken', 'healthy'], 'ios backgrounding during a failed listener setup never opens subsequent workspaces'],
  ['android', ['broken', 'healthy'], 'android backgrounding during a failed listener setup never opens subsequent workspaces'],
  ['ios', ['broken'], 'ios backgrounding during the last failed listener setup never starts periodic recovery'],
  ['android', ['broken'], 'android backgrounding during the last failed listener setup never starts periodic recovery'],
]) test(name, async () => {
  const effects = [], opened = []; let appStateListener, recoveries = 0;
  const groups = groupIds.map((groupId) => ({ userId: 'owner', groupId, status: 'active' }));
  const appState = { currentState: 'active', addEventListener: (_event, listener) => { appStateListener = listener; return { remove() {} }; } };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} }, 'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), knownSharingWorkspaces: async () => groups,
        openSharedWorkspace: async (group) => {
          opened.push(group.groupId);
          if (group.groupId === 'broken') { appState.currentState = 'background'; appStateListener('background'); throw new Error('DB open interrupted'); }
          return { watch: () => () => {} };
        },
        subscribeSharingChanges: () => () => {}, syncKnownSharingWorkspaces: async () => { recoveries++; },
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush(); disposeForeground = effects.at(-1)(); await screen.flush();
    assert.deepEqual(opened, ['broken']);
    assert.equal(recoveries, 0, 'a failed final group must not start recovery after the app has backgrounded');
  } finally { disposeForeground?.(); disposeBoot?.(); }
});

for (const [platform, name] of [
  ['ios', 'ios one unreadable group does not disable healthy foreground listeners or periodic recovery'],
  ['android', 'android one unreadable group does not disable healthy foreground listeners or periodic recovery'],
]) test(name, async () => {
  const effects = [], watches = []; let unsubscribed = 0, recoveries = 0;
  const groups = ['broken', 'healthy'].map((groupId) => ({ userId: 'owner', groupId, status: 'active' }));
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {}, '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
      '@/platform/sharing/private-calendar-sync': { startPrivateCalendarForeground: () => () => {}, syncKnownPrivateCalendar: async () => {} },
      '@/platform/sharing/auth': { observeSharingUser: () => () => {} },
      'react-native': { AppState: appState },
      '@/platform/sharing/workspaces': {
        readSharingSelection: async () => null, hasSharingSessionEnabled: async () => true,
        sharingSessionUser: async () => ({ uid: 'owner' }), knownSharingWorkspaces: async () => groups,
        openSharedWorkspace: async (group) => {
          if (group.groupId === 'broken') throw new Error('protected database cannot open');
          return { watch: () => { watches.push(group.groupId); return () => { unsubscribed++; }; } };
        },
        subscribeSharingChanges: () => () => {}, syncKnownSharingWorkspaces: async () => { recoveries++; },
      },
    } });
  const disposeBoot = effects[0](); let disposeForeground;
  try {
    await screen.flush(); disposeForeground = effects.at(-1)(); await screen.flush();
    assert.deepEqual(watches, ['healthy']);
    assert.equal(recoveries, 1, 'a failed group must not prevent the recovery coordinator from being started');
  } finally { disposeForeground?.(); disposeBoot?.(); }
  assert.equal(unsubscribed, 1);
});
