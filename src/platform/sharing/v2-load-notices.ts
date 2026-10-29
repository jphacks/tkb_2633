import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { createV2LoadNoticeStore } from '../storage/sharing-v2-load-notices';
import { createV2LoadNoticeRuntime, v2LoadNoticePrefix } from '../../features/sharing/v2/load-notice-runtime';
import { createV2ImmediateNoticePresenter } from './v2-immediate-notices';
import type { SQLiteDatabase } from 'expo-sqlite';
import type { V2DailyLoadAssessment } from '../../features/sharing/v2/daily-load';
import type { V2ReminderControl } from '../storage/sharing-v2-reminders';

/** No time input, Calendar lookup, personal rescheduling or new worker is available through this adapter. */
export function createNativeV2LoadNotices(input: { database: SQLiteDatabase; userId: string; groupId: string;
  assertAccess(): void | Promise<void>; readControl(): Promise<V2ReminderControl>;
  readCurrent(): Promise<{ assessment?: V2DailyLoadAssessment; control: V2ReminderControl }> }) {
  return createV2LoadNoticeRuntime({ ...input, store: createV2LoadNoticeStore(input.database, input),
    hasPermission: () => expoLocalNotificationGateway.hasPermission(),
    present: createV2ImmediateNoticePresenter(input, { prefix: v2LoadNoticePrefix(input.userId, input.groupId), kind: 'v2-housework-load',
      channelId: 'housework-load-warnings', channelName: '1日の家事の負荷' }) });
}
