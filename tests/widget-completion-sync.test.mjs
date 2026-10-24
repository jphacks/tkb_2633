import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

const { createWidgetCompletionSync } = await import('../src/features/widgets/widget-completion-sync.ts');

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
