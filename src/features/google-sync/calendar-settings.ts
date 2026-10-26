import type { SQLiteDatabase } from 'expo-sqlite';
import { loadCalendarAvailabilityState, loadPlannerSnapshot, saveCalendarAvailabilityState, setCalendarAvailabilityEnabled } from '@/platform/storage/repository';
import { withGoogleSyncOperation } from './operation-lock';
import { notifyGooglePlannerChanges } from './planner-change-events';
import { sharedRepositoryAdapter } from '@/platform/storage/shared-repository-adapter';

/** Foreground user action only. Settings changes wait for any in-flight Calendar/Tasks sync. */
export async function configureGoogleCalendarAvailability(
  database: SQLiteDatabase, enabled: boolean, authorize: () => Promise<void>,
): Promise<boolean> {
  if (sharedRepositoryAdapter(database)) {
    if (enabled) throw new Error('共有の予定には個人のGoogle Calendarの忙しさを使用しません。');
    return false;
  }
  return withGoogleSyncOperation(async () => {
    let granted = enabled;
    if (enabled) {
      try { await authorize(); } catch { granted = false; }
    }
    await setCalendarAvailabilityEnabled(database, granted);
    if (enabled && !granted) {
      const state = await loadCalendarAvailabilityState(database);
      if (state) await saveCalendarAvailabilityState(database, { ...state, status: 'permissionRequired', lastErrorCode: 'calendar_permission_required' });
    }
    await loadPlannerSnapshot(database);
    notifyGooglePlannerChanges();
    return granted;
  });
}
