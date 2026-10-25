import type { GoogleSyncEntry, GoogleSyncState, GoogleTaskStatusChange, GoogleTaskLink, GoogleTaskStatus } from './contracts';
import { parseGoogleCompletedAt } from './google-completion-policy';
import { GOOGLE_TASKS_LIST_TITLE, GoogleTaskNotFoundError } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTask, GoogleTaskPatch, GoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';

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
  today: string;
}): Promise<GoogleReconciliationResult> {
  const { accessToken, repository, api, now, today } = options;
  const { state } = options;
  const taskLists = await api.listTaskLists(accessToken);
  const taskList = taskLists.find((candidate) => candidate.id === state.taskListId)
    ?? taskLists.find((candidate) => candidate.title === GOOGLE_TASKS_LIST_TITLE)
    ?? await api.createTaskList(accessToken, GOOGLE_TASKS_LIST_TITLE);
  if (!taskList.id) throw new Error('Google Tasks did not return a task list ID');

  const links = await repository.listGoogleTaskLinks(state.householdId);
  const remoteTasks = await api.listTasks(accessToken, taskList.id);
  const tasksById = new Map(remoteTasks.map((task) => [task.id, task]));
  const beforeEntries = new Map((await repository.listEntriesForGoogleSync(today, state.householdId))
    .map((item) => [item.entry.id, item]));
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

  for (const item of entries) {
    const entry = item.entry;
    let link = linksById.get(entry.id);
    let task: GoogleTask | null = null;
    if (link) {
      task = link.googleTaskListId === taskList.id ? tasksById.get(link.googleTaskId) ?? null : null;
      if (!task || task.deleted) {
        await repository.deleteGoogleTaskLink(link.scheduleEntryId);
        linksById.delete(link.scheduleEntryId);
        link = undefined;
        task = null;
        // A remote deletion never removes local history or recreates deleted history.
        if (item.completedAt) continue;
      }
    }

    if (!task || !link) {
      task = await api.createTask(accessToken, taskList.id, {
        title: item.choreName,
        due: googleDueDate(entry.suggestedDate),
      });
      if (!task.id) throw new Error('Google Tasks did not return a task ID');
      link = {
        scheduleEntryId: entry.id,
        householdId: state.householdId,
        choreId: entry.choreId,
        googleTaskListId: taskList.id,
        googleTaskId: task.id,
        lastSyncedTitle: item.choreName,
        lastSyncedDueDate: entry.suggestedDate,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      };
      await repository.upsertGoogleTaskLink(link);
      linksById.set(entry.id, link);
      created += 1;
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
      await api.patchTask(accessToken, taskList.id, task.id, patch);
      updated += 1;
    }
    if (link.lastSyncedTitle !== item.choreName || link.lastSyncedDueDate !== entry.suggestedDate) {
      link = { ...link, lastSyncedTitle: item.choreName, lastSyncedDueDate: entry.suggestedDate, updatedAt: now.toISOString() };
      await repository.upsertGoogleTaskLink(link);
      linksById.set(entry.id, link);
    }
    const acknowledgedStatus = patch.status ?? task.status;
    if ((acknowledgedStatus !== 'completed' || item.completedAt)
      && (link.lastSyncedStatus !== acknowledgedStatus || link.pendingStatus)) {
      await repository.acknowledgeGoogleTaskStatus(link, acknowledgedStatus);
    }
  }

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
