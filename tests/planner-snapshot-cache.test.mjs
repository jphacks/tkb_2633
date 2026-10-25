import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');
const { localDateFromDate } = await import('../src/domain/scheduling/local-date.ts');

test('cached snapshot reads perform no writes and mutations, date changes and clock rollback invalidate them', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    const snapshot = await repository.loadPlannerSnapshot(h.database);
    h.writes.length = 0;
    assert.equal(repository.readCachedPlannerSnapshot(h.database), snapshot);
    assert.equal(repository.readCachedPlannerSnapshot(h.database), snapshot);
    assert.equal(h.writes.length, 0);
    const nextDay = new Date(); nextDay.setDate(nextDay.getDate() + 1);
    assert.notEqual(localDateFromDate(nextDay), localDateFromDate(new Date()));
    assert.equal(repository.readCachedPlannerSnapshot(h.database, nextDay), null);
    assert.equal(repository.readCachedPlannerSnapshot(h.database, new Date('2020-01-01T00:00:00Z')), null);
    await repository.setChoreEnabled(h.database, snapshot.chores[0].id, false);
    assert.equal(repository.readCachedPlannerSnapshot(h.database), null);
  } finally { h.connection.close(); }
});
