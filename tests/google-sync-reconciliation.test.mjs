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
    async importGoogleTaskChanges() { return 0; },
    async acknowledgeGoogleTaskStatus(link, status) {
      if (!this.links) return;
      this.links = this.links.map((item) => item.scheduleEntryId === link.scheduleEntryId
        ? { ...item, lastSyncedStatus: status, pendingStatus: undefined, pendingStatusRevision: undefined } : item);
    },
  };
  const state = { householdId, enabled: true, taskListId, status: 'idle', retryCount: 0, updatedAt: now.toISOString() };
  const api = {
    taskLists: [...taskLists],
    tasks: new Map(tasks.map((task) => [`${task.taskListId}/${task.id}`, { ...task }])),
    calls: { createList: 0, create: 0, batchSizes: [], patchBatchSizes: [], patch: [], deleted: [], get: 0, list: 0 },
    async listTaskLists() { return [...this.taskLists]; },
    async listTasks(_token, listId) {
      this.calls.list += 1;
      return [...this.tasks.values()].filter((task) => task.taskListId === listId).map((task) => ({ ...task }));
    },
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
    async createTasksBatch(_token, listId, drafts) {
      this.calls.batchSizes.push(drafts.length);
      const results = [];
      for (const [index, draft] of drafts.entries()) {
        const task = await this.createTask('token', listId, draft);
        results.push({ requestId: `request-${index}`, ok: true, task });
      }
      return results;
    },
    async patchTask(_token, listId, id, patch) {
      this.calls.patch.push({ id, patch: { ...patch } });
      const key = `${listId}/${id}`;
      const task = { ...this.tasks.get(key), ...patch };
      this.tasks.set(key, task);
      return { ...task };
    },
    async patchTasksBatch(_token, listId, updates) {
      this.calls.patchBatchSizes.push(updates.length);
      return Promise.all(updates.map(async ({ taskId, patch }, index) => ({
        requestId: `request-${index}`, ok: true, task: await this.patchTask('token', listId, taskId, patch),
      })));
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

test('new tasks are created only through the rolling two-week window', async () => {
  const harness = createHarness({ entries: [
    entry('near-window'),
    entry('outside-window', { entry: { ...entry('outside-window').entry, suggestedDate: '2026-11-09' } }),
  ] });

  await reconcile(harness);

  assert.equal(harness.api.calls.create, 1);
  assert.deepEqual(harness.repository.links.map((item) => item.scheduleEntryId), ['near-window']);
  assert.equal(harness.api.tasks.size, 1);
});

test('new task creation is split into batches of at most 100 requests', async () => {
  const harness = createHarness({ entries: Array.from({ length: 205 }, (_, index) => entry(`batch-${index}`)) });

  await reconcile(harness);

  assert.deepEqual(harness.api.calls.batchSizes, [100, 100, 5]);
  assert.equal(harness.api.calls.batchSizes.every((size) => size <= 100), true);
  assert.equal(harness.api.calls.create, 205);
  assert.equal(harness.repository.links.length, 205);
});

test('205 linked tasks moved beyond the creation window keep their IDs and update in batches of 100, 100, 5', async () => {
  const entries = Array.from({ length: 205 }, (_, index) => entry(`moved-${index}`, {
    entry: { ...entry(`moved-${index}`).entry, suggestedDate: '2026-11-30' },
  }));
  const links = entries.map(({ entry }) => link(entry.id, `existing-${entry.id}`));
  const tasks = links.map((link) => ({ id: link.googleTaskId, taskListId, title: link.lastSyncedTitle,
    due: '2026-10-26T00:00:00.000Z', status: 'needsAction' }));
  const harness = createHarness({ entries, links, tasks });

  const result = await reconcile(harness);
  assert.equal(result.updated, 205);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [100, 100, 5]);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.api.calls.deleted.length, 0);
  assert.deepEqual(harness.repository.links.map((link) => link.googleTaskId), links.map((link) => link.googleTaskId));
  assert.ok([...harness.api.tasks.values()].every((task) => task.due === '2026-11-30T00:00:00.000Z'));

  assert.equal((await reconcile(harness)).updated, 0);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [100, 100, 5]);
});

test('partial update failures acknowledge successes and retry only the failed linked task', async () => {
  const entries = ['one', 'two', 'three'].map((id) => entry(id, {
    entry: { ...entry(id).entry, suggestedDate: '2026-10-28' },
  }));
  const links = entries.map(({ entry }) => link(entry.id, `existing-${entry.id}`));
  const tasks = links.map((link) => ({ id: link.googleTaskId, taskListId, title: link.lastSyncedTitle,
    due: '2026-10-26T00:00:00.000Z', status: 'needsAction' }));
  const harness = createHarness({ entries, links, tasks });
  let failOnce = true;
  harness.api.patchTasksBatch = async (_token, listId, updates) => {
    harness.api.calls.patchBatchSizes.push(updates.length);
    const results = [];
    for (const [index, update] of updates.entries()) {
      results.push(failOnce && index === 1
        ? { requestId: `request-${index}`, ok: false, status: 429, code: 'RESOURCE_EXHAUSTED', retryAfter: '3600' }
        : { requestId: `request-${index}`, ok: true,
          task: await harness.api.patchTask('token', listId, update.taskId, update.patch) });
    }
    failOnce = false;
    return results;
  };

  await assert.rejects(reconcile(harness), (error) => error.status === 429 && error.retryAfter === '3600');
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'one').lastSyncedDueDate, '2026-10-28');
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'two').lastSyncedDueDate, '2026-10-26');
  assert.equal(harness.repository.links.find((link) => link.scheduleEntryId === 'three').lastSyncedDueDate, '2026-10-28');
  assert.equal((await reconcile(harness)).updated, 1);
  assert.deepEqual(harness.api.calls.patchBatchSizes, [3, 1]);
  assert.equal(harness.api.calls.patch.length, 3);
  assert.equal(harness.api.calls.create, 0);
});

test('a partial batch failure saves successful mappings and retry adopts already-created remote tasks', async () => {
  const harness = createHarness({ entries: [entry('partial-1'), entry('partial-2'), entry('partial-3')] });
  const createBatch = harness.api.createTasksBatch.bind(harness.api);
  let failOnce = true;
  harness.api.createTasksBatch = async (...args) => {
    const results = await createBatch(...args);
    if (failOnce) {
      failOnce = false;
      results[1] = { requestId: 'request-1', ok: false, status: 503, code: 'backend_error' };
    }
    return results;
  };

  await assert.rejects(reconcile(harness), /Google Tasks request failed/u);
  assert.equal(harness.repository.links.length, 2);
  assert.equal(harness.api.tasks.size, 3);

  await reconcile(harness, new Date(now.getTime() + 1000));
  assert.equal(harness.api.tasks.size, 3);
  assert.equal(harness.repository.links.length, 3);
  assert.equal(harness.api.calls.create, 3);
});

test('reinitializing local storage adopts an existing same-name, same-date task instead of duplicating it', async () => {
  const existingTask = {
    id: 'existing-task', taskListId, title: '食器を洗う', due: '2026-10-26T00:00:00.000Z', status: 'needsAction',
  };
  const reinitializedEntry = entry('new-local-entry-id', { choreName: '食器を洗う' });
  const harness = createHarness({ entries: [reinitializedEntry], tasks: [existingTask] });

  await reconcile(harness);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.repository.links[0].googleTaskId, existingTask.id);

  // Simulate app data being initialized again while the Google list survives.
  harness.repository.links = [];
  await reconcile(harness);
  assert.equal(harness.api.calls.create, 0);
  assert.equal(harness.api.tasks.size, 1);
  assert.equal(harness.repository.links[0].googleTaskId, existingTask.id);
});

test('linked tasks outside the creation window still receive completion changes', async () => {
  const futureEntry = entry('future-linked', {
    completedAt: '2026-10-25T11:30:00.000Z',
    entry: { ...entry('future-linked').entry, suggestedDate: '2026-11-30' },
  });
  const existingLink = link('future-linked', 'future-task', { lastSyncedStatus: 'needsAction' });
  const harness = createHarness({
    entries: [futureEntry],
    links: [existingLink],
    tasks: [{ id: 'future-task', taskListId, title: '家事 future-linked', due: '2026-11-30T00:00:00.000Z', status: 'needsAction' }],
  });

  await reconcile(harness);

  assert.deepEqual(harness.api.calls.patch, [{
    id: 'future-task', patch: { status: 'completed', completed: '2026-10-25T11:30:00.000Z' },
  }]);
  assert.equal(harness.api.calls.create, 0);
});

test('unvalidated remote completion is not reverted; obsolete open tasks are deleted and completed history is preserved', async () => {
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

test('moving an active entry to the current list cleans the old task without deleting the new mapping', async () => {
  const harness = createHarness({ entries: [entry('entry-1')],
    links: [link('entry-1', 'old-task', { googleTaskListId: 'old-list' })],
    tasks: [{ id: 'old-task', taskListId: 'old-list', title: '家事 entry-1', status: 'needsAction' }],
  });
  await reconcile(harness);
  assert.equal(harness.repository.links.length, 1);
  assert.equal(harness.repository.links[0].googleTaskListId, taskListId);
  assert.notEqual(harness.repository.links[0].googleTaskId, 'old-task');
  assert.deepEqual(harness.api.calls.deleted, ['old-task']);
});
