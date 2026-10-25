import type { GoogleSyncEntry, GoogleSyncState, GoogleTaskStatusChange, GoogleTaskLink, GoogleTaskStatus } from './contracts';
import { parseGoogleCompletedAt } from './google-completion-policy';
import { GOOGLE_TASKS_BATCH_MAX_REQUESTS, GOOGLE_TASKS_LIST_TITLE, GoogleTaskNotFoundError, GoogleTasksApiError } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTask, GoogleTaskPatch, GoogleTasksApi, GoogleTasksBatchItemResult } from '@/platform/google-tasks/google-tasks-api';
import { addDays } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';

/** Keep the Google list useful by synchronizing a rolling two-week planner window. */
export const GOOGLE_TASK_SYNC_WINDOW_DAYS = 14;

export interface GoogleSyncRepositoryPort {
  listEntriesForGoogleSync(today: string, householdId: string): Promise<GoogleSyncEntry[]>;
  listGoogleTaskLinks(householdId: string): Promise<GoogleTaskLink[]>;
  upsertGoogleTaskLink(link: GoogleTaskLink): Promise<void>;
  deleteGoogleTaskLink(scheduleEntryId: string): Promise<void>;
  importGoogleTaskChanges(changes: readonly GoogleTaskStatusChange[], today: string): Promise<number>;
  acknowledgeGoogleTaskStatus(link: GoogleTaskLink, status: GoogleTaskStatus): Promise<void>;
}

export interface GoogleReconciliationResult {
  taskListId: string;
  created: number;
  updated: number;
  removed: number;
  imported: number;
  remoteTasksRead: number;
  hiddenCompletionsRead: number;
  invalidCompletions: number;
}

export async function reconcileGoogleTasks(options: {
  accessToken: string;
  state: GoogleSyncState;
  repository: GoogleSyncRepositoryPort;
  api: GoogleTasksApi;
  now: Date;
  today: LocalDate;
}): Promise<GoogleReconciliationResult> {
  const { accessToken, repository, api, now, today } = options;
  const { state } = options;
  const syncThrough = addDays(today, GOOGLE_TASK_SYNC_WINDOW_DAYS);
  const isInSyncWindow = (item: GoogleSyncEntry) => item.entry.suggestedDate <= syncThrough;
  const taskLists = await api.listTaskLists(accessToken);
  const taskList = taskLists.find((candidate) => candidate.id === state.taskListId)
    ?? taskLists.find((candidate) => candidate.title === GOOGLE_TASKS_LIST_TITLE)
    ?? await api.createTaskList(accessToken, GOOGLE_TASKS_LIST_TITLE);
  if (!taskList.id) throw new Error('Google Tasks did not return a task list ID');

  let links = await repository.listGoogleTaskLinks(state.householdId);
  const remoteTasks = await api.listTasks(accessToken, taskList.id);
  const tasksById = new Map(remoteTasks.map((task) => [task.id, task]));
  const beforeEntries = new Map((await repository.listEntriesForGoogleSync(today, state.householdId))
    .map((item) => [item.entry.id, item]));

  // A local reinstall/reset can remove SQLite links while the app-created Google tasks remain.
  // Adopt an exact title + due-date match in our dedicated list before creating a new task.
  const usedTaskIds = new Set(links.filter((link) => link.googleTaskListId === taskList.id).map((link) => link.googleTaskId));
  const linkedScheduleEntryIds = new Set(links.map((link) => link.scheduleEntryId));
  const tasksByOccurrence = new Map<string, GoogleTask[]>();
  for (const task of remoteTasks) {
    const dueDate = googleDueLocalDate(task.due);
    if (!dueDate || task.deleted || (task.status !== 'completed' && task.status !== 'needsAction')) continue;
    const key = occurrenceKey(task.title, dueDate);
    tasksByOccurrence.set(key, [...(tasksByOccurrence.get(key) ?? []), task]);
  }
  for (const item of beforeEntries.values()) {
    if (!isInSyncWindow(item) || linkedScheduleEntryIds.has(item.entry.id)) continue;
    const candidates = tasksByOccurrence.get(occurrenceKey(item.choreName, item.entry.suggestedDate)) ?? [];
    const existingTask = candidates.find((task) => !usedTaskIds.has(task.id));
    if (!existingTask) continue;
    const adoptedLink = {
      scheduleEntryId: item.entry.id,
      householdId: state.householdId,
      choreId: item.entry.choreId,
      googleTaskListId: taskList.id,
      googleTaskId: existingTask.id,
      lastSyncedTitle: item.choreName,
      lastSyncedDueDate: item.entry.suggestedDate,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await repository.upsertGoogleTaskLink(adoptedLink);
    links = [...links, adoptedLink];
    usedTaskIds.add(existingTask.id);
    linkedScheduleEntryIds.add(item.entry.id);
  }

  const changes: GoogleTaskStatusChange[] = [];
  let invalidCompletions = 0;
  for (const link of links) {
    if (link.googleTaskListId !== taskList.id) continue;
    const task = tasksById.get(link.googleTaskId);
    if (!task || task.deleted || (task.status !== 'completed' && task.status !== 'needsAction')) continue;
    const local = beforeEntries.get(link.scheduleEntryId);
    const localStatus = local?.completedAt ? 'completed' : 'needsAction';
    const locallyChanged = link.pendingStatus
      || (local && link.lastSyncedStatus && localStatus !== link.lastSyncedStatus)
      || (local?.locallyIncomplete && !link.lastSyncedStatus);
    if (locallyChanged) continue;
    if (task.status === 'needsAction') {
      if (link.lastSyncedStatus === 'completed' && local?.completedAt) {
        changes.push({ googleTaskListId: taskList.id, googleTaskId: task.id,
          scheduleEntryId: link.scheduleEntryId, status: 'needsAction' });
      }
      continue;
    }
    if (link.lastSyncedStatus === 'completed' && local?.completedAt) continue;
    const completedAt = parseGoogleCompletedAt(task.completed);
    if (!completedAt) {
      invalidCompletions += 1;
      continue;
    }
    changes.push({
      googleTaskListId: taskList.id,
      googleTaskId: task.id,
      scheduleEntryId: link.scheduleEntryId,
      completedAt,
      status: 'completed',
    });
  }
  // Pull actual remote state changes in one transaction before writing to Google.
  const imported = changes.length ? await repository.importGoogleTaskChanges(changes, today) : 0;
  const entries = await repository.listEntriesForGoogleSync(today, state.householdId);
  const linksById = new Map((await repository.listGoogleTaskLinks(state.householdId)).map((link) => [link.scheduleEntryId, link]));
  const entriesById = new Map(entries.map(({ entry }) => [entry.id, entry]));
  let created = 0;
  let updated = 0;
  let removed = 0;
  const createCandidates: GoogleSyncEntry[] = [];
  type PendingPatch = { item: GoogleSyncEntry; task: GoogleTask; link: GoogleTaskLink; patch: GoogleTaskPatch };
  const pendingPatches: PendingPatch[] = [];
  const persistSyncedEntry = async (item: GoogleSyncEntry, originalLink: GoogleTaskLink, status: GoogleTaskStatus) => {
    let link = originalLink;
    if (link.lastSyncedTitle !== item.choreName || link.lastSyncedDueDate !== item.entry.suggestedDate) {
      link = { ...link, lastSyncedTitle: item.choreName, lastSyncedDueDate: item.entry.suggestedDate, updatedAt: now.toISOString() };
      await repository.upsertGoogleTaskLink(link);
      linksById.set(item.entry.id, link);
    }
    if ((status !== 'completed' || item.completedAt) && (link.lastSyncedStatus !== status || link.pendingStatus)) {
      await repository.acknowledgeGoogleTaskStatus(link, status);
    }
  };
  const applyPatches = async (candidates: readonly PendingPatch[]) => {
    for (let offset = 0; offset < candidates.length; offset += GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
      const chunk = candidates.slice(offset, offset + GOOGLE_TASKS_BATCH_MAX_REQUESTS);
      const results = api.patchTasksBatch
        ? await api.patchTasksBatch(accessToken, taskList.id, chunk.map(({ task, patch }) => ({ taskId: task.id, patch })))
        : await runTaskRequestsSequentially(chunk, ({ task, patch }) => api.patchTask(accessToken, taskList.id, task.id, patch));
      let firstFailure: GoogleTasksApiError | undefined;
      for (const [index, candidate] of chunk.entries()) {
        const result = results[index];
        if (!result || !result.ok) {
          firstFailure ??= result && !result.ok
            ? new GoogleTasksApiError(result.status, result.code, result.retryAfter ?? null)
            : new GoogleTasksApiError(502, 'missing_batch_response', null);
          continue;
        }
        if (result.task.id !== candidate.task.id) {
          firstFailure ??= new GoogleTasksApiError(502, 'mismatched_batch_task_id', null);
          continue;
        }
        updated += 1;
        await persistSyncedEntry(candidate.item, candidate.link, result.task.status);
      }
      if (firstFailure) throw firstFailure;
    }
  };

  for (const item of entries) {
    const entry = item.entry;
    const inSyncWindow = isInSyncWindow(item);
    let link = linksById.get(entry.id);
    let task: GoogleTask | null = null;
    if (link) {
      task = link.googleTaskListId === taskList.id ? tasksById.get(link.googleTaskId) ?? null : null;
      if (!task || task.deleted) {
        // Leave an out-of-window link alone; it can be repaired when the entry enters the window.
        if (!inSyncWindow) continue;
        await repository.deleteGoogleTaskLink(link.scheduleEntryId);
        linksById.delete(link.scheduleEntryId);
        link = undefined;
        task = null;
        // A remote deletion never removes local history or recreates deleted history.
        if (item.completedAt) continue;
      }
    }

    // The two-week limit only controls new tasks. A linked task must keep its current
    // due date even when Calendar moves the occurrence beyond the creation window.
    if (!inSyncWindow && (!task || !link)) continue;

    if (!task || !link) {
      createCandidates.push(item);
      continue;
    }

    if (task.status !== 'completed' && task.status !== 'needsAction') continue;
    const localStatus = item.completedAt ? 'completed' : 'needsAction';
    const desiredStatus = link.pendingStatus ?? localStatus;
    const pushLocalStatus = Boolean(link.pendingStatus || (link.lastSyncedStatus && localStatus !== link.lastSyncedStatus)
      || (!link.lastSyncedStatus && item.locallyIncomplete));
    // A completion may have committed just after the entry read. Its queued follow-up has the exact timestamp.
    if (desiredStatus === 'completed' && !item.completedAt) continue;
    const patch: GoogleTaskPatch = {};
    if (task.title !== item.choreName) patch.title = item.choreName;
    if (googleDueLocalDate(task.due) !== entry.suggestedDate) patch.due = googleDueDate(entry.suggestedDate);
    if (desiredStatus === 'completed' && task.status !== 'completed') {
      patch.status = 'completed';
      patch.completed = item.completedAt;
    } else if (desiredStatus === 'needsAction' && task.status === 'completed' && pushLocalStatus) {
      patch.status = 'needsAction';
      patch.completed = null;
    }
    if (Object.keys(patch).length > 0) {
      pendingPatches.push({ item, task, link, patch });
    } else await persistSyncedEntry(item, link, task.status);
  }
  await applyPatches(pendingPatches);

  const newlyCreated: { item: GoogleSyncEntry; task: GoogleTask; link: GoogleTaskLink }[] = [];
  for (let offset = 0; offset < createCandidates.length; offset += GOOGLE_TASKS_BATCH_MAX_REQUESTS) {
    const chunk = createCandidates.slice(offset, offset + GOOGLE_TASKS_BATCH_MAX_REQUESTS);
    const drafts = chunk.map((item) => ({
      title: item.choreName,
      due: googleDueDate(item.entry.suggestedDate),
    }));
    const results = api.createTasksBatch
      ? await api.createTasksBatch(accessToken, taskList.id, drafts)
      : await runTaskRequestsSequentially(drafts, (draft) => api.createTask(accessToken, taskList.id, draft));
    let firstFailure: GoogleTasksApiError | undefined;
    for (let index = 0; index < chunk.length; index += 1) {
      const item = chunk[index];
      const result = results[index];
      if (!item || !result || !result.ok) {
        firstFailure ??= result && !result.ok
          ? new GoogleTasksApiError(result.status, result.code, result.retryAfter ?? null)
          : new GoogleTasksApiError(502, 'missing_batch_response', null);
        continue;
      }
      const task = result.task;
      if (!task.id) {
        firstFailure ??= new GoogleTasksApiError(502, 'missing_batch_task_id', null);
        continue;
      }
      const link: GoogleTaskLink = {
        scheduleEntryId: item.entry.id,
        householdId: state.householdId,
        choreId: item.entry.choreId,
        googleTaskListId: taskList.id,
        googleTaskId: task.id,
        lastSyncedTitle: item.choreName,
        lastSyncedDueDate: item.entry.suggestedDate,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      // Persist each successful response immediately so a later failed chunk resumes safely.
      await repository.upsertGoogleTaskLink(link);
      linksById.set(item.entry.id, link);
      newlyCreated.push({ item, task, link });
      created += 1;
    }
    if (firstFailure) throw firstFailure;
  }

  // A batch cannot depend on a task ID returned by another request in that same batch.
  // Apply local completions to newly inserted tasks after their IDs have been persisted.
  const completionPatches: PendingPatch[] = [];
  for (const { item, task, link } of newlyCreated) {
    if (task.status !== 'completed' && task.status !== 'needsAction') continue;
    if (item.completedAt && task.status !== 'completed') {
      completionPatches.push({ item, task, link, patch: { status: 'completed', completed: item.completedAt } });
    } else await persistSyncedEntry(item, link, task.status);
  }
  await applyPatches(completionPatches);

  // Cleanup runs last, after imported completions have been preserved by the repository.
  for (const link of links) {
    if (!linksById.has(link.scheduleEntryId)) continue;
    if (entriesById.has(link.scheduleEntryId) && link.googleTaskListId === taskList.id) continue;
    const task = link.googleTaskListId === taskList.id ? tasksById.get(link.googleTaskId) ?? null : undefined;
    await removeObsoleteLink(accessToken, link, api, task);
    const currentLink = linksById.get(link.scheduleEntryId);
    if (currentLink?.googleTaskListId === link.googleTaskListId && currentLink.googleTaskId === link.googleTaskId) {
      await repository.deleteGoogleTaskLink(link.scheduleEntryId);
      linksById.delete(link.scheduleEntryId);
    }
    removed += 1;
  }

  return {
    taskListId: taskList.id, created, updated, removed, imported,
    remoteTasksRead: remoteTasks.length,
    hiddenCompletionsRead: remoteTasks.filter((task) => task.hidden && !task.deleted && task.status === 'completed').length,
    invalidCompletions,
  };
}

async function runTaskRequestsSequentially<T>(
  items: readonly T[], request: (item: T) => Promise<GoogleTask>,
): Promise<GoogleTasksBatchItemResult[]> {
  const results: GoogleTasksBatchItemResult[] = [];
  for (const [index, item] of items.entries()) {
    try {
      results.push({ requestId: `request-${index}`, ok: true, task: await request(item) });
    } catch (error) {
      const apiError = error instanceof GoogleTasksApiError ? error : undefined;
      results.push({ requestId: `request-${index}`, ok: false, status: apiError?.status ?? 500, code: apiError?.code ?? 'task_request_failed',
        ...(apiError?.retryAfter ? { retryAfter: apiError.retryAfter } : {}) });
    }
  }
  return results;
}

function occurrenceKey(title: string, dueDate: string): string {
  return JSON.stringify([title, dueDate]);
}

async function removeObsoleteLink(accessToken: string, link: GoogleTaskLink, api: GoogleTasksApi, knownTask?: GoogleTask | null): Promise<void> {
  let task = knownTask;
  if (task === undefined) {
    try {
      task = await api.getTask(accessToken, link.googleTaskListId, link.googleTaskId);
    } catch (error) {
      if (error instanceof GoogleTaskNotFoundError) return;
      throw error;
    }
  }
  if (task && !task.deleted && task.status !== 'completed') {
    try {
      await api.deleteTask(accessToken, link.googleTaskListId, link.googleTaskId);
    } catch (error) {
      if (!(error instanceof GoogleTaskNotFoundError)) throw error;
    }
  }
}

function googleDueDate(localDate: string): string {
  return `${localDate}T00:00:00.000Z`;
}

function googleDueLocalDate(value: string | undefined): string | null {
  return value?.slice(0, 10) ?? null;
}
