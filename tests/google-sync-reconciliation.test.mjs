import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

const { reconcileGoogleTasks } = await import('../src/features/google-sync/reconcile-google-tasks.ts');
const { GoogleTaskNotFoundError } = await import('../src/platform/google-tasks/google-tasks-api.ts');

const householdId = 'local-household';
const taskListId = 'list-1';
const now = new Date('2026-10-25T12:00:00.000Z');

function entry(id, overrides = {}) {
  return {
    entry: {
      id,
      householdId,
      choreId: `chore-${id}`,
      cycleBaseDate: '2026-10-26',
      windowStart: '2026-10-25',
      windowEnd: '2026-10-27',
      suggestedDate: '2026-10-26',
      status: 'scheduled',
      assignedMemberIds: [],
    },
    choreName: `家事 ${id}`,
    ...overrides,
  };
}

function createHarness({ entries = [], links = [], tasks = [], taskLists = [{ id: taskListId, title: '家事Planner' }] } = {}) {
  const repository = {
    entries: [...entries],
    links: [...links],
    async listEntriesForGoogleSync() { return [...this.entries]; },
    async listGoogleTaskLinks() { return [...this.links]; },
    async upsertGoogleTaskLink(link) {
      this.links = [...this.links.filter((item) => item.scheduleEntryId !== link.scheduleEntryId), link];
    },
    async deleteGoogleTaskLink(scheduleEntryId) {
      this.links = this.links.filter((item) => item.scheduleEntryId !== scheduleEntryId);
    },
  };
  const state = { householdId, enabled: true, taskListId, status: 'idle', retryCount: 0, updatedAt: now.toISOString() };
  const api = {
    taskLists: [...taskLists],
    tasks: new Map(tasks.map((task) => [`${task.taskListId}/${task.id}`, { ...task }])),
    calls: { createList: 0, create: 0, patch: [], deleted: [], get: 0 },
    async listTaskLists() { return [...this.taskLists]; },
    async createTaskList(_token, title) {
      this.calls.createList += 1;
      const created = { id: `new-list-${this.calls.createList}`, title };
      this.taskLists.push(created);
      return created;
    },
    async getTask(_token, listId, id) {
      this.calls.get += 1;
      const task = this.tasks.get(`${listId}/${id}`);
      if (!task) throw new GoogleTaskNotFoundError();
      return { ...task };
    },
    async createTask(_token, listId, draft) {
      this.calls.create += 1;
      const task = { id: `task-${this.calls.create}`, ...draft, taskListId: listId, status: 'needsAction' };
      this.tasks.set(`${listId}/${task.id}`, task);
      return { ...task };
    },
    async patchTask(_token, listId, id, patch) {
      this.calls.patch.push({ id, patch: { ...patch } });
      const key = `${listId}/${id}`;
      const task = { ...this.tasks.get(key), ...patch };
      this.tasks.set(key, task);
      return { ...task };
    },
    async deleteTask(_token, listId, id) {
      this.calls.deleted.push(id);
      this.tasks.delete(`${listId}/${id}`);
    },
  };
  return { repository, api, state };
}

function link(scheduleEntryId, googleTaskId, overrides = {}) {
  return {
    scheduleEntryId,
    householdId,
    choreId: `chore-${scheduleEntryId}`,
    googleTaskListId: taskListId,
    googleTaskId,
    lastSyncedTitle: `家事 ${scheduleEntryId}`,
    lastSyncedDueDate: '2026-10-26',
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    ...overrides,
  };
}

async function reconcile(harness, time = now) {
  return reconcileGoogleTasks({
    accessToken: 'access-token',
    state: harness.state,
    repository: harness.repository,
    api: harness.api,
    now: time,
    today: '2026-10-25',
  });
}

test('reconciliation creates once, then updates the same Google Task for title, due date, and app completion', async () => {
  const harness = createHarness({ entries: [entry('entry-1')] });
  await reconcile(harness);
  const savedLink = harness.repository.links[0];
  const taskKey = `${taskListId}/${savedLink.googleTaskId}`;
  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.api.tasks.get(taskKey), {
    id: savedLink.googleTaskId,
    title: '家事 entry-1',
    due: '2026-10-26T00:00:00.000Z',
    taskListId,
    status: 'needsAction',
  });

  harness.repository.entries = [entry('entry-1', {
    choreName: '新しい家事名',
    entry: { ...entry('entry-1').entry, suggestedDate: '2026-10-28' },
  })];
  await reconcile(harness, new Date(now.getTime() + 1000));
  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.api.calls.patch.at(-1), {
    id: savedLink.googleTaskId,
    patch: { title: '新しい家事名', due: '2026-10-28T00:00:00.000Z' },
  });

  harness.repository.entries = [entry('entry-1', {
    choreName: '新しい家事名',
    completedAt: '2026-10-25T11:30:00.000Z',
    entry: { ...entry('entry-1').entry, suggestedDate: '2026-10-28' },
  })];
  await reconcile(harness, new Date(now.getTime() + 2000));
  assert.deepEqual(harness.api.calls.patch.at(-1), {
    id: savedLink.googleTaskId,
    patch: { status: 'completed', completed: '2026-10-25T11:30:00.000Z' },
  });
});

test('remote completion is never reverted, while obsolete open tasks are deleted and completed history is preserved', async () => {
  const harness = createHarness({
    links: [link('obsolete-open', 'task-open'), link('obsolete-done', 'task-done')],
    tasks: [
      { id: 'task-open', taskListId, title: '古い未完了', status: 'needsAction' },
      { id: 'task-done', taskListId, title: '完了済み', status: 'completed' },
      { id: 'task-remote-done', taskListId, title: 'Google側で完了', due: '2026-10-26T00:00:00.000Z', status: 'completed' },
    ],
    entries: [entry('remote-done')],
  });
  harness.repository.links.push(link('remote-done', 'task-remote-done'));

  await reconcile(harness);
  assert.deepEqual(harness.api.calls.deleted, ['task-open']);
  assert.equal(harness.repository.links.some((item) => item.scheduleEntryId === 'obsolete-open'), false);
  assert.equal(harness.repository.links.some((item) => item.scheduleEntryId === 'obsolete-done'), false);
  assert.equal(harness.api.tasks.get(`${taskListId}/task-done`).status, 'completed');
  assert.equal(harness.api.tasks.get(`${taskListId}/task-remote-done`).status, 'completed');
  assert.equal(harness.api.calls.patch.some(({ patch }) => patch.status === 'needsAction'), false);
});

test('a manually deleted Google Task is recreated with a fresh stable mapping', async () => {
  const harness = createHarness({ entries: [entry('entry-1')], links: [link('entry-1', 'missing-task')] });
  await reconcile(harness);
  assert.equal(harness.api.calls.create, 1);
  assert.notEqual(harness.repository.links[0].googleTaskId, 'missing-task');
});

test('missing dedicated task list is created once and persisted by the coordinator result', async () => {
  const harness = createHarness({ entries: [], taskLists: [] });
  const result = await reconcile(harness);
  assert.equal(harness.api.calls.createList, 1);
  assert.equal(result.taskListId, 'new-list-1');
});
