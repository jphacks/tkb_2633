import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

for (const [platform, name] of [
  ['ios', 'ios foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
  ['android', 'android foreground sharing listener errors recheck membership instead of leaving revoked groups actionable until the next interval'],
]) test(name, async () => {
  const effects = []; const watches = []; const synchronizations = []; let unsubscribed = 0;
  const group = { userId: 'owner', groupId: 'group-test', status: 'active', displayName: '家族' };
  const workspace = { ...group, database: {}, adapter: { readSnapshot: async () => ({}) },
    watch: (changed, failed) => { watches.push({ changed, failed }); return () => { unsubscribed++; }; },
    async sync() { synchronizations.push('membership-check'); throw new Error('synthetic unavailable or permission-denied'); } };
  const appState = { currentState: 'active', addEventListener: () => ({ remove() {} }) };
  const screen = screenHarness('src/hooks/use-workspace.tsx', { platform, exportName: 'WorkspaceProvider', effect: (callback) => effects.push(callback),
    mocks: {
      '@/components/planner-ui': {},
      '@/contexts/workspace-context': { WorkspaceContext: { Provider: 'WorkspaceContextProvider' } },
      './use-planner-data': { usePlannerData: () => ({ database: {} }) },
      '@/platform/storage/repository': { drainPlannerDatabaseOperations: async () => {} },
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
