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
  hasPendingGoogleTaskChanges,
  saveGoogleSyncState,
  upsertGoogleTaskLink,
} from '@/platform/storage/repository';
import type { SQLiteDatabase } from 'expo-sqlite';
import { classifyGoogleSyncFailure } from './error-classification';
import type { GoogleSyncFailureDetails } from './error-classification';
import { googleSyncRunOptions, isGoogleSyncAttemptStale, shouldSyncGoogleTasks } from './sync-policy';
import type { GoogleSyncTriggerOptions } from './sync-policy';
import type { GoogleSyncState } from './contracts';
import { reconcileGoogleTasks } from './reconcile-google-tasks';
import type { GoogleSyncRepositoryPort } from './reconcile-google-tasks';
import { notifyGooglePlannerChanges } from './planner-change-events';
import { withGoogleSyncOperation } from './operation-lock';
import { sharedRepositoryAdapter } from '@/platform/storage/shared-repository-adapter';
import { sharedGoogleNamespace, sharedPlannerChangeScope } from './workspace-policy';

export type GoogleSyncRunResult =
  | { kind: 'success'; skipped?: boolean; created?: number; updated?: number; removed?: number; imported?: number; remoteTasksRead?: number; hiddenCompletionsRead?: number; invalidCompletions?: number }
  | { kind: 'retry'; code: string }
  | { kind: 'authRequired'; code: string }
  | { kind: 'error'; code: string };

export interface GoogleSyncCoordinatorDependencies extends GoogleSyncRepositoryPort {
  /** The actual SQLite connection/workspace for native calls; injected ports use their own identity. */
  syncScope?: object;
  today?: LocalDate;
  loadState(): Promise<GoogleSyncState | null>;
  saveState(state: GoogleSyncState): Promise<void>;
  getAccessToken(): Promise<string>;
  hasPendingLocalChanges?(lastSuccessfulSyncAt?: string): Promise<boolean>;
  api: GoogleTasksApi;
  refreshCalendar?(options: { now: Date; today: LocalDate; force: boolean }): Promise<{ plannerChanged: boolean }>;
}

const runningSync = new WeakMap<object, Promise<GoogleSyncRunResult>>();
const executingSync = new WeakSet<object>();
const pendingCompletionSyncDatabases = new Set<SQLiteDatabase>();

export async function syncGoogleTasks(
  database: SQLiteDatabase,
  options: GoogleSyncTriggerOptions & { now?: Date } = {},
): Promise<GoogleSyncRunResult> {
  const now = options.now ?? new Date();
  const householdId = 'local-household';
  const shared = sharedRepositoryAdapter(database);
  const sharedSnapshot = shared ? await shared.readSnapshot(now) : null;
  if (sharedSnapshot?.sharing?.issues.some((issue) => issue.kind === 'conflict' || issue.kind === 'dependencyCycle')) return { kind: 'success', skipped: true };
  const sharedToday = sharedSnapshot?.today;
  const startedAt = Date.now();
  let readRequests = 0;
  let writeRequests = 0;
  let writeOperations = 0;
  const result = await syncGoogleTasksWithDependencies({
    syncScope: database,
    ...(shared ? { taskNamespace: sharedGoogleNamespace(shared.userId, shared.groupId), today: sharedToday } : {}),
    loadState: () => loadGoogleSyncState(database, householdId),
    hasPendingLocalChanges: (lastSuccess) => hasPendingGoogleTaskChanges(database, lastSuccess, householdId),
    saveState: (state) => saveGoogleSyncState(database, state),
    getAccessToken: async () => {
      const { getBoundGoogleAccessToken } = await import('@/platform/google-tasks/bound-session');
      return getBoundGoogleAccessToken(database, 'tasks');
    },
    refreshCalendar: shared ? undefined : async (calendarOptions) => {
      const { refreshGoogleCalendarAvailability } = await import('./calendar-coordinator');
      return refreshGoogleCalendarAvailability(database, calendarOptions);
    },
    api: createGoogleTasksApi(fetch, (method, operationCount = 1) => {
      if (method === 'GET') readRequests += 1;
      else {
        writeRequests += 1;
        writeOperations += operationCount;
      }
    }),
    importGoogleTaskChanges: async (changes, today) => {
      const imported = await importGoogleTaskChanges(database, changes, today as LocalDate, now);
      if (imported > 0) {
        const handled = notifyGooglePlannerChanges(shared ? sharedPlannerChangeScope(shared.userId, shared.groupId) : 'personal');
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
    ...googleSyncRunOptions(options),
    now,
  });
  if (readRequests + writeRequests > 0 && typeof __DEV__ !== 'undefined' && __DEV__) {
    console.info('[google-sync]', {
      result: result.kind,
      durationMs: Date.now() - startedAt,
      readRequests,
      writeRequests,
      writeOperations,
      ...(result.kind === 'success' ? { created: result.created, updated: result.updated, removed: result.removed,
        remoteTasksRead: result.remoteTasksRead, hiddenCompletionsRead: result.hiddenCompletionsRead, imported: result.imported }
        : { code: result.code }),
    });
  }
  return result;
}

/** Best-effort immediate propagation for in-app and widget completion actions. */
export function syncGoogleTasksAfterLocalCompletion(database: SQLiteDatabase): void {
  if (runningSync.has(database)) {
    // A queued run has not read yet and will see this committed change already.
    if (executingSync.has(database)) pendingCompletionSyncDatabases.add(database);
    return;
  }
  void syncGoogleTasks(database, { force: true, trigger: 'completion' }).catch(() => undefined);
}

export async function syncGoogleTasksWithDependencies(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force?: boolean; forceCalendar?: boolean; now: Date; recoverInterruptedAttempt?: boolean },
): Promise<GoogleSyncRunResult> {
  const scope = dependencies.syncScope ?? dependencies;
  const existing = runningSync.get(scope);
  if (existing) return existing;
  const run = withGoogleSyncOperation(async () => {
    executingSync.add(scope);
    try { return await runSync(dependencies, {
      force: options.force ?? false,
      forceCalendar: options.forceCalendar ?? options.force ?? false,
      now: options.now,
      recoverInterruptedAttempt: options.recoverInterruptedAttempt ?? false,
    }); } finally { executingSync.delete(scope); }
  });
  runningSync.set(scope, run);
  try {
    return await run;
  } finally {
    if (runningSync.get(scope) === run) {
      runningSync.delete(scope);
      const database = scope as SQLiteDatabase;
      if (pendingCompletionSyncDatabases.delete(database)) {
        void Promise.resolve().then(() => syncGoogleTasks(database, { force: true, trigger: 'completion' })).catch(() => undefined);
      }
    }
  }
}

async function runSync(
  dependencies: GoogleSyncCoordinatorDependencies,
  options: { force: boolean; forceCalendar: boolean; now: Date; recoverInterruptedAttempt: boolean },
): Promise<GoogleSyncRunResult> {
  const { now } = options;
  let state = await dependencies.loadState();
  if (!state?.enabled) return { kind: 'success', skipped: true };
  // Native Android widget actions can commit while JS is stopped. Recover their
  // durable changes on startup/resume without changing Calendar cadence or
  // bypassing an existing retry/auth/permission failure on every foreground.
  const pendingLocalChanges = (state.status === 'idle' || state.status === 'syncing')
    && await dependencies.hasPendingLocalChanges?.(state.lastSuccessfulSyncAt) === true;
  const force = options.force || pendingLocalChanges;
  const staleAttempt = isGoogleSyncAttemptStale(state, now);
  if (state.status === 'syncing' && !staleAttempt && !options.recoverInterruptedAttempt && !pendingLocalChanges) {
    return { kind: 'success', skipped: true };
  }
  let calendarChanged = false;
  try {
    calendarChanged = (await dependencies.refreshCalendar?.({ now, today: localDateFromDate(now), force: options.forceCalendar }))?.plannerChanged ?? false;
  } catch (error) {
    if (typeof __DEV__ !== 'undefined' && __DEV__) {
      console.warn('[google-calendar]', {
        result: 'coordinator_error',
        errorName: error instanceof Error ? error.name : 'UnknownError',
      });
    }
    // Calendar failure is isolated; Tasks completion and retry policy continue.
  }
  if (!force && !calendarChanged && !staleAttempt && !shouldSyncGoogleTasks(state, now)) return { kind: 'success', skipped: true };

  const attemptAt = now.toISOString();
  state = {
    ...state,
    status: 'syncing',
    lastAttemptAt: attemptAt,
    nextRetryAt: undefined,
    updatedAt: attemptAt,
  };

  try {
    await dependencies.saveState(state);
    const accessToken = await dependencies.getAccessToken();
    const result = await reconcileGoogleTasks({
      accessToken,
      state,
      repository: dependencies,
      api: dependencies.api,
      now,
      today: dependencies.today ?? localDateFromDate(now),
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
    try {
      await dependencies.saveState(failedState);
    } catch {
      return { kind: 'error', code: 'sync_state_persist_failed' };
    }
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
