import type { SQLiteDatabase } from 'expo-sqlite';
import type { LocalDate } from '@/domain/shared/types';
import { loadPlannerSnapshot } from '@/platform/storage/repository';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';

/** Refresh the same widget and digest outputs used after ordinary planner completion. */
export async function refreshPlannerAfterGoogleImport(database: SQLiteDatabase, today: LocalDate): Promise<void> {
  const snapshot = await loadPlannerSnapshot(database, today);
  publishTodayWidgetSnapshot(snapshot);
  await syncDailyHouseworkDigest(expoLocalNotificationGateway, snapshot).catch(() => undefined);
}
