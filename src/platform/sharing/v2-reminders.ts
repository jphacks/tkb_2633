import { openDatabaseAsync } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { readPersonalPlannerOverlaySnapshot } from '../storage/repository';
import { createV2ReminderStore } from '../storage/sharing-v2-reminders';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { createV2ReminderRuntime } from '../../features/sharing/v2/reminder-runtime';
import type { V2GroupController } from '../../features/sharing/v2/controller';
import { createV2ScreenSession } from '../../features/sharing/v2-ui/screen-session';
import { createV2PrivateTaskSource } from '../../features/sharing/v2-ui/private-overlay';
import { v2OwnerScheduleSettings } from '../../features/sharing/v2-ui/owner-preferences';
import { openPrivateCalendarRuntime } from './private-calendar-runtime';
import { reconcileLocalNotifications } from '../../features/notifications/reconcile-local-notifications';
import { v2NotificationPrefix } from '../../features/sharing/v2/native-identity';

/** Local v2 projection only; never register a legacy planner adapter or acquire OAuth here. */
export function createNativeV2Reminders(input: { database: SQLiteDatabase; userId: string; groupId: string;
  controller: V2GroupController; assertAccess(): void | Promise<void> }) {
  const store = createV2ReminderStore(input.database, input);
  return createV2ReminderRuntime({ ...input, store, gateway: expoLocalNotificationGateway,
    readModel: async now => {
      await input.assertAccess(); const personal = await openDatabaseAsync('housework.db', { useNewConnection: true });
      try {
        await input.assertAccess(); const snapshot = await readPersonalPlannerOverlaySnapshot(personal, now); await input.assertAccess();
        const calendar = openPrivateCalendarRuntime(input.userId);
        const session = createV2ScreenSession({ controller: input.controller, userId: input.userId, groupId: input.groupId, now: () => now,
          readPreferences: async () => { const own = await calendar.readPlannerPreferences?.(); await input.assertAccess(); return v2OwnerScheduleSettings(input.userId, snapshot.snapshot.settings, own); },
          privateTasks: createV2PrivateTaskSource({ ownerUserId: input.userId, assertAccess: input.assertAccess,
            readSnapshot: async () => ({ ...snapshot, ownerUserId: input.userId }), save: async () => { throw new Error('通知から個人家事は変更できません。'); } }),
          calendar });
        const model = await session.readModel({ reminders: true }); await input.assertAccess(); return model;
      } finally { await personal.closeAsync(); }
    } });
}

/** A previous account/removed group may cancel its own reminders without reading group data. */
export async function clearInactiveV2Reminders(allowed: readonly { userId: string; groupId: string }[], assertCurrent: () => void | Promise<void> = () => {}) {
  await assertCurrent();
  const keep = new Set(allowed.map(scope => v2NotificationPrefix(scope.userId, scope.groupId)));
  const scheduled = await expoLocalNotificationGateway.getScheduledRequests();
  await assertCurrent();
  const prefixes = new Set(scheduled.flatMap(request => {
    const match = /^liflow-v2-digest:[a-f0-9]{64}:/u.exec(request.key); return match && !keep.has(match[0]) ? [match[0]] : [];
  }));
  const failures: unknown[] = [];
  for (const prefix of prefixes) try { await reconcileLocalNotifications(expoLocalNotificationGateway, { prefix, enabled: false, desired: [], assertCurrent }); }
  catch (error) { failures.push(error); }
  if (failures.length) throw failures[0];
}
export function clearV2RemindersForScope(userId: string, groupId: string) {
  return reconcileLocalNotifications(expoLocalNotificationGateway, { prefix: v2NotificationPrefix(userId, groupId), enabled: false, desired: [] });
}
