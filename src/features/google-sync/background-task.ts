import * as BackgroundTask from 'expo-background-task';
import { Platform } from 'react-native';
import * as SQLite from 'expo-sqlite';
import * as TaskManager from 'expo-task-manager';

import { syncGoogleTasks } from './coordinator';
import { initializeLocalDatabase, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID } from '@/platform/storage/repository';

export const GOOGLE_SYNC_BACKGROUND_TASK = 'housework-planner-google-tasks-sync';
const MINIMUM_INTERVAL_MINUTES = 60;

TaskManager.defineTask(GOOGLE_SYNC_BACKGROUND_TASK, async ({ error }) => {
  if (error) return BackgroundTask.BackgroundTaskResult.Failed;
  if (Platform.OS === 'web') return BackgroundTask.BackgroundTaskResult.Success;

  let database: SQLite.SQLiteDatabase | null = null;
  try {
    database = await SQLite.openDatabaseAsync('housework.db');
    await initializeLocalDatabase(database);
    const state = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
    if (!state?.enabled) return BackgroundTask.BackgroundTaskResult.Success;
    await syncGoogleTasks(database);
    // Retry times are persisted locally; OS-level retries are reserved for execution/storage failures.
    return BackgroundTask.BackgroundTaskResult.Success;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  } finally {
    await database?.closeAsync().catch(() => undefined);
  }
});

export async function registerGoogleSyncBackgroundTask(): Promise<boolean> {
  if (Platform.OS === 'web' || !(await TaskManager.isAvailableAsync())) return false;
  if (await BackgroundTask.getStatusAsync() !== BackgroundTask.BackgroundTaskStatus.Available) return false;
  const registered = await TaskManager.getRegisteredTasksAsync();
  if (!registered.some((task) => task.taskName === GOOGLE_SYNC_BACKGROUND_TASK)) {
    await BackgroundTask.registerTaskAsync(GOOGLE_SYNC_BACKGROUND_TASK, { minimumInterval: MINIMUM_INTERVAL_MINUTES });
  }
  return true;
}

export async function unregisterGoogleSyncBackgroundTask(): Promise<void> {
  if (Platform.OS === 'web' || !(await TaskManager.isAvailableAsync())) return;
  const registered = await TaskManager.getRegisteredTasksAsync();
  if (registered.some((task) => task.taskName === GOOGLE_SYNC_BACKGROUND_TASK)) {
    await BackgroundTask.unregisterTaskAsync(GOOGLE_SYNC_BACKGROUND_TASK);
  }
}
