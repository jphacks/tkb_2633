import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

const loadedSnapshot = { household: { name: '家族' }, settings: { notificationsEnabled: true } };
for (const [platform, snapshot, name] of [
  ['ios', null, 'ios leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: no snapshot'],
  ['ios', loadedSnapshot, 'ios leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: loaded'],
  ['android', null, 'android leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: no snapshot'],
  ['android', loadedSnapshot, 'android leaving a shared planner cancels only its reminder namespace even when its snapshot is unavailable: loaded'],
]) {
    test(name, async () => {
      const effects = [], cancelled = []; const gateway = {}; let invalidated = 0;
      const shared = { userId: 'member', groupId: 'group-test' };
      const scope = 'a'.repeat(64);
      const controller = { getSnapshot: () => ({ snapshot }), subscribe: () => () => {}, invalidate() { invalidated++; } };
      const { PlannerDataProvider } = loadNativeModule('src/hooks/use-planner-data.ts', {
        'expo-sqlite': { useSQLiteContext: () => ({}) },
        react: { createContext: () => ({}), useMemo: (callback) => callback(),
          useEffect: (callback) => effects.push(callback), createElement: () => null },
        'react-native': { Platform: { OS: platform }, AppState: { currentState: 'background', addEventListener: () => ({ remove() {} }) } },
        '@/domain/scheduling/local-date': {}, '@/platform/storage/repository': {}, '@/platform/widgets/refresh-planner-from-widget': {},
        '@/features/widgets/publish-today-widget-snapshot': {},
        '@/features/notifications/daily-housework-digest': { syncDailyHouseworkDigest: async (usedGateway, state) => {
          assert.equal(usedGateway, gateway); cancelled.push(state);
        } },
        '@/platform/notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
        '@/features/google-sync/planner-change-events': { subscribeToGooglePlannerChanges: () => () => {} },
        '@/features/google-sync/background-task': {}, '@/features/google-sync/coordinator': {},
        '@/features/planner/refresh-controller': { createPlannerRefreshController: () => controller },
        '@/platform/storage/shared-repository-adapter': { sharedRepositoryAdapter: () => shared },
        '@/features/google-sync/workspace-policy': { sharedGoogleNamespace: (userId, groupId) => {
          assert.equal(userId, shared.userId); assert.equal(groupId, shared.groupId); return scope;
        }, sharedPlannerChangeScope: () => scope },
        '@/features/sharing/group-clock': {}, '@/platform/sharing/workspaces': { subscribeSharingChanges: () => () => {} },
      });
      PlannerDataProvider({ children: null, databaseOverride: {} });
      const dispose = effects[0]();
      dispose();
      await Promise.resolve();
      assert.equal(invalidated, 1);
      assert.equal(cancelled.length, 1, 'startup failure, access revocation and group switches must all cancel old reminders');
      assert.equal(cancelled[0].notificationScope, scope);
      assert.equal(cancelled[0].settings.notificationsEnabled, false);
    });
}
