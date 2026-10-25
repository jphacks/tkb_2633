import type { GoogleSyncEntry, GoogleSyncState, GoogleTaskLink } from './contracts';
import { GOOGLE_TASKS_LIST_TITLE, GoogleTaskNotFoundError } from '@/platform/google-tasks/google-tasks-api';
import type { GoogleTask, GoogleTasksApi } from '@/platform/google-tasks/google-tasks-api';

export interface GoogleSyncRepositoryPort {
  listEntriesForGoogleSync(today: string, householdId: string): Promise<GoogleSyncEntry[]>;
  listGoogleTaskLinks(householdId: string): Promise<GoogleTaskLink[]>;
  upsertGoogleTaskLink(link: GoogleTaskLink): Promise<void>;
  deleteGoogleTaskLink(scheduleEntryId: string): Promise<void>;
}

export async function reconcileGoogleTasks(options: {
  accessToken: string;
  state: GoogleSyncState;
  repository: GoogleSyncRepositoryPort;
  api: GoogleTasksApi;
  now: Date;
  today: string;
}): Promise<{ taskListId: string; created: number; updated: number; removed: number }> {
  const { accessToken, repository, api, now, today } = options;
  const { state } = options;
  const taskLists = await api.listTaskLists(accessToken);
  const taskList = taskLists.find((candidate) => candidate.id === state.taskListId)
    ?? taskLists.find((candidate) => candidate.title === GOOGLE_TASKS_LIST_TITLE)
    ?? await api.createTaskList(accessToken, GOOGLE_TASKS_LIST_TITLE);
  if (!taskList.id) throw new Error('Google Tasks did not return a task list ID');

  const entries = await repository.listEntriesForGoogleSync(today, state.householdId);
  const entriesById = new Map(entries.map(({ entry }) => [entry.id, entry]));
  const links = await repository.listGoogleTaskLinks(state.householdId);
  const linksById = new Map(links.map((link) => [link.scheduleEntryId, link]));
  let created = 0;
  let updated = 0;
  let removed = 0;

  for (const link of links) {
    const entryIsCurrent = entriesById.has(link.scheduleEntryId);
    if (entryIsCurrent && link.googleTaskListId === taskList.id) continue;
    await removeObsoleteLink(accessToken, link, api);
    await repository.deleteGoogleTaskLink(link.scheduleEntryId);
    linksById.delete(link.scheduleEntryId);
    removed += 1;
  }

  for (const item of entries) {
    const entry = item.entry;
    let link = linksById.get(entry.id);
    let task: GoogleTask | null = null;
    if (link) {
      try {
        task = await api.getTask(accessToken, link.googleTaskListId, link.googleTaskId);
      } catch (error) {
        if (!(error instanceof GoogleTaskNotFoundError)) throw error;
      }
      if (!task || task.deleted) {
        await repository.deleteGoogleTaskLink(link.scheduleEntryId);
        linksById.delete(link.scheduleEntryId);
        link = undefined;
        task = null;
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

    const patch: { title?: string; due?: string; status?: 'completed'; completed?: string } = {};
    if (task.title !== item.choreName) patch.title = item.choreName;
    if (googleDueLocalDate(task.due) !== entry.suggestedDate) patch.due = googleDueDate(entry.suggestedDate);
    if (item.completedAt && task.status !== 'completed') {
      patch.status = 'completed';
      patch.completed = item.completedAt;
    }
    if (Object.keys(patch).length > 0) {
      await api.patchTask(accessToken, taskList.id, task.id, patch);
      updated += 1;
      if (link.lastSyncedTitle !== item.choreName || link.lastSyncedDueDate !== entry.suggestedDate) {
        link = {
          ...link,
          lastSyncedTitle: item.choreName,
          lastSyncedDueDate: entry.suggestedDate,
          updatedAt: now.toISOString(),
        };
        await repository.upsertGoogleTaskLink(link);
        linksById.set(entry.id, link);
      }
    }
  }

  return { taskListId: taskList.id, created, updated, removed };
}

async function removeObsoleteLink(accessToken: string, link: GoogleTaskLink, api: GoogleTasksApi): Promise<void> {
  let task: GoogleTask;
  try {
    task = await api.getTask(accessToken, link.googleTaskListId, link.googleTaskId);
  } catch (error) {
    if (error instanceof GoogleTaskNotFoundError) return;
    throw error;
  }
  if (!task.deleted && task.status !== 'completed') {
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
