import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPlannerRefreshController } from '../src/features/planner/refresh-controller.ts';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test('concurrent refreshes share one load and merge widget actions', async () => {
  const calls = [], published = [];
  const controller = createPlannerRefreshController({
    load: async (ids, force) => { calls.push({ ids, force }); return { snapshot: { revision: 1 }, canPublishWidget: true }; },
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  await Promise.all([controller.refresh({ widgetCompletionIds: ['one'] }),
    controller.refresh({ widgetCompletionIds: ['two'] }), controller.refresh()]);
  assert.deepEqual(calls, [{ ids: ['one', 'two'], force: true }]);
  assert.equal(published.length, 1);
  assert.equal(controller.getSnapshot().loading, false);
});

test('a mutation during load queues one new read and never publishes the stale result', async () => {
  const first = deferred(); let loads = 0; const published = [];
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot: ++loads === 1 ? await first.promise : 'new', canPublishWidget: true }),
    weather: async () => null, publish: (snapshot) => published.push(snapshot),
  });
  const earlier = controller.refresh();
  await Promise.resolve();
  const later = controller.refresh();
  first.resolve('old');
  await Promise.all([earlier, later]);
  assert.equal(loads, 2);
  assert.deepEqual(published, ['new']);
});

test('unchanged cached snapshots do not publish effects again; widget recovery still publishes', async () => {
  const snapshot = {}; let canPublishWidget = false; const published = [];
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot, canPublishWidget }), weather: async () => null,
    publish: (_snapshot, canPublish) => published.push(canPublish),
  });
  await controller.refresh(); await controller.refresh();
  assert.deepEqual(published, [false]);
  canPublishWidget = true;
  await controller.refresh();
  assert.deepEqual(published, [false, true]);
});

test('a late weather result cannot publish over a newer snapshot or after invalidation', async () => {
  const delayed = deferred(); const published = []; let generation = 0; let oldCanCommit;
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot: ++generation, canPublishWidget: true }),
    weather: async (_snapshot, canCommit) => { if (generation === 1) { oldCanCommit = canCommit; return delayed.promise; } return null; },
    publish: (snapshot) => published.push(snapshot),
  });
  await controller.refresh(); await controller.refresh();
  assert.equal(oldCanCommit(), false);
  delayed.resolve('stale weather');
  await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(published, [1, 2]);
  controller.invalidate();
  assert.equal(oldCanCommit(), false);
});

test('a failed output update keeps the screen usable and retries for the same cached snapshot', async () => {
  const snapshot = {}; let attempts = 0;
  const controller = createPlannerRefreshController({
    load: async () => ({ snapshot, canPublishWidget: true }), weather: async () => null,
    publish: async () => { if (++attempts === 1) throw new Error('temporary output failure'); },
  });
  await controller.refresh();
  assert.equal(controller.getSnapshot().snapshot, snapshot);
  assert.equal(controller.getSnapshot().error, null);
  await controller.refresh();
  assert.equal(attempts, 2);
});
