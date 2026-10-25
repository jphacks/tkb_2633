import type { SQLiteDatabase } from 'expo-sqlite';
import { loadCalendarAvailabilityState, loadPlannerSnapshot, saveCalendarAvailabilityState, setCalendarAvailabilityEnabled } from '@/platform/storage/repository';
import { withGoogleSyncOperation } from './operation-lock';
import { notifyGooglePlannerChanges } from './planner-change-events';

/** Foreground user action only. Settings changes wait for any in-flight Calendar/Tasks sync. */
export async function configureGoogleCalendarAvailability(
  database: SQLiteDatabase, enabled: boolean, authorize: () => Promise<void>,
): Promise<boolean> {
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
