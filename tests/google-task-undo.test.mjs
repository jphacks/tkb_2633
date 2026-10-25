import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createIntegration, repository, now } from './helpers/google-sync-integration.mjs';
const { GoogleTasksApiError } = await import('../src/platform/google-tasks/google-tasks-api.ts');

test('app complete → Google complete → app undo → Google open uses the same mapped task', async () => {
  const h = await createIntegration();
  try {
    await h.sync();
    const entry = h.entries[0];
    await repository.completeChore(h.database, entry);
    await h.sync();
    assert.equal(h.tasks.get('remote-0').status, 'completed');
    const original = h.history()[0];
    await repository.undoCompletedChore(h.database, original.id);
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.tasks.get('remote-0').status, 'needsAction');
    assert.equal(h.tasks.get('remote-0').completed, null);
    assert.equal(h.history()[0].outcome, 'incomplete');
    const link = (await repository.listGoogleTaskLinks(h.database)).find((item) => item.scheduleEntryId === entry.id);
    assert.equal(link.googleTaskId, 'remote-0');
    assert.equal(link.lastSyncedStatus, 'needsAction');
    assert.equal(link.pendingStatus, undefined);
    assert.equal((await h.sync()).imported, 0);
    assert.equal(h.history().length, 1);
  } finally { h.connection.close(); }
});

test('Google complete → Google undo → Google recomplete updates one occurrence and restores its cycle', async () => {
  const h = await createIntegration({ cycleDays: 7, previousDate: '2026-10-18' });
  try {
    const before = { ...h.state() };
    const task = h.tasks.get('remote-0');
    Object.assign(task, { status: 'completed', completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 1);
    const id = h.history()[0].id;
    Object.assign(task, { status: 'needsAction', completed: null });
    assert.equal((await h.sync()).imported, 1);
    assert.equal(h.history()[0].id, id);
    assert.equal(h.history()[0].outcome, 'incomplete');
    assert.deepEqual({ ...h.state() }, before);
    Object.assign(task, { status: 'completed', completed: now.toISOString() });
    assert.equal((await h.sync()).imported, 1);
    assert.equal(h.history().length, 1);
    assert.equal(h.history()[0].id, id);
    assert.equal(h.history()[0].outcome, 'completed');
  } finally { h.connection.close(); }
});

test('an offline local undo survives a failed PATCH and retries without resurrecting completion', async () => {
  const h = await createIntegration();
  try {
    await repository.completeChore(h.database, h.entries[0]);
    await h.sync();
    await repository.undoCompletedChore(h.database, h.history()[0].id);
    const patch = h.dependencies.api.patchTasksBatch;
    h.dependencies.api.patchTasksBatch = async () => { throw new GoogleTasksApiError(503, 'unavailable', null); };
    assert.equal((await h.sync()).kind, 'retry');
    assert.equal(h.history()[0].outcome, 'incomplete');
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, 'needsAction');
    h.dependencies.api.patchTasksBatch = patch;
    assert.equal((await h.sync()).kind, 'success');
    assert.equal(h.history()[0].outcome, 'incomplete');
    assert.equal(h.tasks.get('remote-0').status, 'needsAction');
  } finally { h.connection.close(); }
});

test('a new local action during the undo PATCH is not acknowledged by the older revision', async () => {
  const h = await createIntegration();
  try {
    const entry = h.entries[0];
    await repository.completeChore(h.database, entry);
    await h.sync();
    await repository.undoCompletedChore(h.database, h.history()[0].id);
    const patch = h.dependencies.api.patchTasksBatch;
    h.dependencies.api.patchTasksBatch = async (...args) => {
      if (args[2].some((update) => update.patch.status === 'needsAction')) await repository.completeChore(h.database, entry);
      return patch(...args);
    };
    await h.sync();
    assert.equal(h.history()[0].outcome, 'completed');
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, 'completed');
    h.dependencies.api.patchTasksBatch = patch;
    await h.sync();
    assert.equal(h.tasks.get('remote-0').status, 'completed');
    assert.equal((await repository.listGoogleTaskLinks(h.database))[0].pendingStatus, undefined);
  } finally { h.connection.close(); }
});
