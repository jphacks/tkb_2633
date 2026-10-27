import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createWidgetCompletionSync } = await import('../src/features/widgets/widget-completion-sync.ts');
const { createPlannerRefreshController } = await import('../src/features/planner/refresh-controller.ts');

function fixture(overrides = {}) {
  const entries = ['one', 'two'].map((id) => ({ id, choreId: id, windowStart: '2026-10-24', windowEnd: '2026-10-24' }));
  const completions = [];
  const stats = { loads: 0, completed: [], published: [] };
  const dependencies = {
    async load() { stats.loads += 1; return { scheduleEntries: entries, completions: [...completions] }; },
    async pendingIds() { return ['one', 'two', 'one']; },
    async complete(entry) {
      stats.completed.push(entry.id);
      completions.push({ id: entry.id, choreId: entry.choreId, outcome: 'completed', scheduleEntryId: entry.id });
      return true;
    },
    publish(snapshot) { stats.published.push(snapshot); },
    ...overrides,
  };
  return { synchronize: createWidgetCompletionSync(dependencies), stats };
}

test('widget completions are batched, deduplicated, and published once after all saves', async () => {
  const { synchronize, stats } = fixture();
  const result = await synchronize();
  assert.equal(result.snapshot.completions.length, 2);
  assert.deepEqual(stats.completed, ['one', 'two']);
  assert.equal(stats.loads, 2);
  assert.equal(stats.published.length, 1);
});

test('a failed completion keeps the widget pending actions for a retry', async () => {
  const { synchronize, stats } = fixture({ async complete() { throw new Error('database busy'); } });
  const result = await synchronize();
  assert.equal(result.canPublishWidget, false);
  assert.equal(stats.published.length, 0);
  assert.equal(result.snapshot.scheduleEntries.length, 2);
});

test('a failed timeline read leaves the planner usable and does not erase widget actions', async () => {
  const { synchronize, stats } = fixture({ async pendingIds() { throw new Error('unavailable'); } });
  assert.equal((await synchronize()).canPublishWidget, false);
  assert.equal(stats.loads, 1);
  assert.equal(stats.published.length, 0);
});

test('concurrent widget callbacks do not complete the same occurrence twice', async () => {
  const { synchronize, stats } = fixture();
  await Promise.all([synchronize(['one']), synchronize(['one'])]);
  assert.deepEqual(stats.completed, ['one', 'two']);
});

test('a native widget publishing failure does not reject a planner refresh', async () => {
  const { synchronize } = fixture({ publish() { throw new Error('native extension missing'); } });
  assert.equal((await synchronize()).snapshot.completions.length, 2);
});

test('a completion saved by another caller is reloaded before acknowledging the widget', async () => {
  let loads = 0;
  const entry = { id: 'one', choreId: 'one' };
  const synchronize = createWidgetCompletionSync({
    async pendingIds() { return ['one']; },
    async load() {
      loads += 1;
      return { scheduleEntries: [entry], completions: loads === 1 ? [] : [{
        id: 'done', choreId: 'one', outcome: 'completed', scheduleEntryId: 'one',
      }] };
    },
    async complete() { return false; },
    publish() {},
  });
  assert.equal((await synchronize()).snapshot.completions.length, 1);
  assert.equal(loads, 2);
});

test('cancelling a queued planner refresh preserves durable widget actions for foreground recovery', async () => {
  const entry = { id: 'one', choreId: 'one', windowStart: '2026-10-24', windowEnd: '2026-10-24' };
  const pending = new Set(['one']);
  const completions = [];
  let saves = 0;
  const synchronize = createWidgetCompletionSync({
    async pendingIds() { return [...pending]; },
    async load() { return { scheduleEntries: [entry], completions: [...completions] }; },
    async complete(saved) {
      saves += 1;
      completions.push({ id: 'done', choreId: saved.choreId, outcome: 'completed', scheduleEntryId: saved.id });
      return true;
    },
    publish() { assert.fail('the refresh controller owns native publication'); },
  });
  const controller = createPlannerRefreshController({
    load: (ids) => synchronize(ids, { publish: false }),
    weather: async () => null,
    publish(snapshot, canPublishWidget) {
      assert.equal(canPublishWidget, true);
      assert.equal(snapshot.completions.length, 1, 'acknowledge only after the local completion is saved');
      pending.clear();
    },
  });
  const cancelled = controller.refresh({ widgetCompletionIds: ['one'] });
  controller.invalidate();
  await cancelled;
  assert.equal(saves, 0);
  assert.deepEqual([...pending], ['one']);

  // A foreground resume has no transient callback IDs; the native queue is the source of truth.
  await controller.refresh({ force: true });
  assert.equal(saves, 1);
  assert.equal(pending.size, 0);
  await controller.refresh({ force: true });
  assert.equal(saves, 1, 'a later refresh must not duplicate the recovered completion');
});
