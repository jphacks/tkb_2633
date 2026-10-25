import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { GoogleTasksApiError, createGoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';
import {
  deleteGoogleTaskLink,
  importGoogleTaskChanges,
  acknowledgeGoogleTaskStatus,
  listEntriesForGoogleSync,
  listGoogleTaskLinks,
  loadGoogleSyncState,
  saveGoogleSyncState,
  upsertGoogleTaskLink,
} from '@/platform/storage/repository';
import type { SQLiteDatabase } from 'expo-sqlite';
import { classifyGoogleSyncFailure } from './error-classification';
import type { GoogleSyncFailureDetails } from './error-classification';
import { isGoogleSyncAttemptStale, shouldSyncGoogleTasks } from './sync-policy';
import type { GoogleSyncState } from './contracts';
import { reconcileGoogleTasks } from './reconcile-google-tasks';
import type { GoogleSyncRepositoryPort } from './reconcile-google-tasks';
import { notifyGooglePlannerChanges } from './planner-change-events';
import { withGoogleSyncOperation } from './operation-lock';

export type GoogleSyncRunResult =
  | { kind: 'success'; skipped?: boolean; created?: number; updated?: number; removed?: number; imported?: number; remoteTasksRead?: number; hiddenCompletionsRead?: number; invalidCompletions?: number }
  | { kind: 'retry'; code: string }
  | { kind: 'authRequired'; code: string }
  | { kind: 'error'; code: string };

export interface GoogleSyncCoordinatorDependencies extends GoogleSyncRepositoryPort {
  loadState(): Promise<GoogleSyncState | null>;
  saveState(state: GoogleSyncState): Promise<void>;
  getAccessToken(): Promise<string>;
  api: GoogleTasksApi;
  refreshCalendar?(options: { now: Date; today: LocalDate; force: boolean }): Promise<{ plannerChanged: boolean }>;
}

let runningSync: Promise<GoogleSyncRunResult> | null = null;
let pendingCompletionSyncDatabase: SQLiteDatabase | null = null;

export async function syncGoogleTasks(
  database: SQLiteDatabase,
  options: { force?: boolean; now?: Date; trigger?: 'manual' | 'completion' } = {},
): Promise<GoogleSyncRunResult> {
  const now = options.now ?? new Date();
  const householdId = 'local-household';
  const startedAt = Date.now();
  let readRequests = 0;
  let writeRequests = 0;
  const result = await syncGoogleTasksWithDependencies({
    loadState: () => loadGoogleSyncState(database, householdId),
    saveState: (state) => saveGoogleSyncState(database, state),
    getAccessToken: async () => {
      const { getGoogleTasksAccessToken } = await import('@/platform/google-tasks/google-sign-in-gateway');
      return getGoogleTasksAccessToken();
    },
    refreshCalendar: async (calendarOptions) => {
      const { refreshGoogleCalendarAvailability } = await import('./calendar-coordinator');
      return refreshGoogleCalendarAvailability(database, calendarOptions);
    },
    api: createGoogleTasksApi(fetch, (method) => {
      if (method === 'GET') readRequests += 1;
      else writeRequests += 1;
    }),
    importGoogleTaskChanges: async (changes, today) => {
      const imported = await importGoogleTaskChanges(database, changes, today as LocalDate, now);
      if (imported > 0) {
        const handled = notifyGooglePlannerChanges();
        if (!handled) try {
          const { refreshPlannerAfterGoogleImport } = await import('@/platform/google-tasks/refresh-planner-after-google-import');
          await refreshPlannerAfterGoogleImport(database, today as LocalDate);
        } catch { /* Saved planner data remains valid if a native widget/digest is unavailable. */ }
      }
      return imported;
    },
    listEntriesForGoogleSync: (today, id) => listEntriesForGoogleSync(database, today as LocalDate, id),
    listGoogleTaskLinks: (id) => listGoogleTaskLinks(database, id),
    upsertGoogleTaskLink: (link) => upsertGoogleTaskLink(database, link),
    acknowledgeGoogleTaskStatus: (link, status) => acknowledgeGoogleTaskStatus(database, link, status),
    deleteGoogleTaskLink: (id) => deleteGoogleTaskLink(database, id),
  }, {
    force: options.force ?? false,
    forceCalendar: options.force === true && options.trigger !== 'completion',
    now,
    // Manual actions may recover a saved attempt from a terminated app process.
    // The shared runningSync promise still joins a live attempt in this process.
    recoverInterruptedAttempt: options.force === true && options.trigger !== 'completion',
  });
  if (readRequests + writeRequests > 0 && typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[google-sync]', {
      result: result.kind,
      durationMs: Date.now() - startedAt,
      readRequests,
      writeRequests,
      ...(result.kind === 'success' ? { remoteTasksRead: result.remoteTasksRead, hiddenCompletionsRead: result.hiddenCompletionsRead, imported: result.imported } : {}),
    });
  }
  return result;
}

/** Best-effort immediate propagation for in-app and widget completion actions. */
export function syncGoogleTasksAfterLocalCompletion(database: SQLiteDatabase): void {
  if (runningSync) {
    pendingCompletionSyncDatabase = database;
    return;
  }
  void syncGoogleTasks(database, { force: true, trigger: 'completion' }).catch(() => undefined);
}

export async function syncGoogleTasksWithDependencies(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force?: boolean; forceCalendar?: boolean; now: Date; recoverInterruptedAttempt?: boolean },
): Promise<GoogleSyncRunResult> {
  if (runningSync) return runningSync;
  const run = withGoogleSyncOperation(() => runSync(dependencies, {
    force: options.force ?? false,
    forceCalendar: options.forceCalendar ?? options.force ?? false,
    now: options.now,
    recoverInterruptedAttempt: options.recoverInterruptedAttempt ?? false,
  }));
  runningSync = run;
  try {
    return await run;
  } finally {
    if (runningSync === run) {
      runningSync = null;
      const pendingDatabase = pendingCompletionSyncDatabase;
      pendingCompletionSyncDatabase = null;
      if (pendingDatabase) {
        void Promise.resolve().then(() => syncGoogleTasks(pendingDatabase, { force: true, trigger: 'completion' })).catch(() => undefined);
      }
    }
  }
}

async function runSync(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force: boolean; forceCalendar: boolean; now: Date; recoverInterruptedAttempt: boolean },
): Promise<GoogleSyncRunResult> {
  const { now, force } = options;
  let state = await dependencies.loadState();
  if (!state?.enabled) return { kind: 'success', skipped: true };
  const staleAttempt = isGoogleSyncAttemptStale(state, now);
  if (state.status === 'syncing' && !staleAttempt && !options.recoverInterruptedAttempt) {
    return { kind: 'success', skipped: true };
  }
  let calendarChanged = false;
  try {
    calendarChanged = (await dependencies.refreshCalendar?.({ now, today: localDateFromDate(now), force: options.forceCalendar }))?.plannerChanged ?? false;
  } catch { /* Calendar failure is isolated; Tasks completion and retry policy continue. */ }
  if (!force && !calendarChanged && !staleAttempt && !shouldSyncGoogleTasks(state, now)) return { kind: 'success', skipped: true };

  const attemptAt = now.toISOString();
  state = {
    ...state,
    status: 'syncing',
    lastAttemptAt: attemptAt,
    nextRetryAt: undefined,
    updatedAt: attemptAt,
  };
  await dependencies.saveState(state);

  try {
    const accessToken = await dependencies.getAccessToken();
    const result = await reconcileGoogleTasks({
      accessToken,
      state,
      repository: dependencies,
      api: dependencies.api,
      now,
      today: localDateFromDate(now),
    });
    if (result.invalidCompletions > 0) {
      console.warn('[google-sync]', { code: 'invalid_remote_completion_timestamp', count: result.invalidCompletions });
    }
    await dependencies.saveState({
      ...state,
      taskListId: result.taskListId,
      status: 'idle',
      retryCount: 0,
      lastSuccessfulSyncAt: now.toISOString(),
      nextRetryAt: undefined,
      lastErrorCode: undefined,
      lastErrorAt: undefined,
      updatedAt: now.toISOString(),
    });
    return { kind: 'success', ...result };
  } catch (error) {
    const failure = toFailureDetails(error);
    const classification = classifyGoogleSyncFailure(failure, now);
    const updatedAt = now.toISOString();
    const failedState: GoogleSyncState = {
      ...state,
      status: classification.kind === 'retry' ? 'retryPending' : classification.kind,
      retryCount: classification.kind === 'retry' ? state.retryCount + 1 : state.retryCount,
      ...(classification.nextRetryAt ? { nextRetryAt: classification.nextRetryAt.toISOString() } : { nextRetryAt: undefined }),
      lastErrorCode: classification.code,
      lastErrorAt: updatedAt,
      updatedAt,
    };
    await dependencies.saveState(failedState);
    return { kind: classification.kind, code: classification.code };
  }
}

function toFailureDetails(error: unknown): GoogleSyncFailureDetails {
  if (error instanceof GoogleTasksApiError) {
    return { status: error.status, code: error.code, retryAfter: error.retryAfter };
  }
  if (error instanceof Error) {
    if (error.name === 'GoogleOAuthConfigurationError') return { code: 'oauth_not_configured' };
    if (error.name === 'GoogleSignInRequiredError') return { code: 'sign_in_required' };
    const nativeCode = (error as Error & { code?: unknown }).code;
    if (typeof nativeCode === 'string') return { code: nativeCode };
    return { code: error.name === 'AbortError' ? 'timeout' : error.name === 'TypeError' ? 'network_error' : error.name };
  }
  return { code: 'unknown_error' };
}
