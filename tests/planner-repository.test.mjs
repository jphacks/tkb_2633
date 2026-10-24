import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';

const repository = await import('../src/platform/storage/repository.ts');

async function setup(database) {
  await repository.initializeLocalDatabase(database);
  const first = await repository.loadPlannerSnapshot(database, '2026-10-24');
  const chore = first.chores[0];
  await repository.completeFirstSetup(database, {
    frequencyMode: 'balanced', restDays: [], enabledChoreIds: [chore.id],
    previousDates: { [chore.id]: { date: '2026-10-01' } }, weatherLocation: null,
  });
  return chore;
}

test('unchanged planner refreshes do not rewrite seed data or generated schedule rows', async () => {
  const { connection, database, writes } = createDatabase();
  try {
    await setup(database);
    await repository.loadPlannerSnapshot(database, '2026-10-24');
    writes.length = 0;
    await repository.loadPlannerSnapshot(database, '2026-10-24');
    assert.equal(writes.length, 0, writes.map((write) => write.sql).join('\n'));
  } finally { connection.close(); }
});

test('concurrent planner refreshes do not nest SQLite transactions', async () => {
  const { connection, database } = createDatabase();
  try {
    await setup(database);
    const results = await Promise.allSettled([
      repository.loadPlannerSnapshot(database, '2026-10-24'),
      repository.loadPlannerSnapshot(database, '2026-10-24'),
    ]);
    assert.ok(results.every((result) => result.status === 'fulfilled'), JSON.stringify(results.map((result) => result.reason?.message)));
  } finally { connection.close(); }
});

test('undoing an older completion preserves a newer completion and undoing both restores the original state', async () => {
  const { connection, database } = createDatabase();
  try {
    const chore = await setup(database);
    connection.prepare('UPDATE chore_state SET last_completed_date = ?, initial_pending = 0 WHERE chore_id = ?')
      .run('2026-10-15', chore.id);
    const original = { choreId: chore.id, lastCompletedDate: '2026-10-01', lastCompletedEstimated: true, initialPending: false };
    const afterFirst = { ...original, lastCompletedDate: '2026-10-08', lastCompletedEstimated: false };
    const insert = connection.prepare(`INSERT INTO chore_completions
      (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome, previous_chore_state_json)
      VALUES (?, ?, ?, ?, 'inApp', ?, 'completed', ?)`);
    insert.run('first', repository.LOCAL_HOUSEHOLD_ID, chore.id, '2026-10-08T03:00:00.000Z', 'entry-first', JSON.stringify(original));
    insert.run('second', repository.LOCAL_HOUSEHOLD_ID, chore.id, '2026-10-15T03:00:00.000Z', 'entry-second', JSON.stringify(afterFirst));
    assert.equal(await repository.undoCompletedChore(database, 'first'), true);
    assert.equal(connection.prepare('SELECT last_completed_date FROM chore_state WHERE chore_id = ?').get(chore.id).last_completed_date, '2026-10-15');
    assert.equal(await repository.undoCompletedChore(database, 'second'), true);
    const restored = connection.prepare('SELECT * FROM chore_state WHERE chore_id = ?').get(chore.id);
    assert.equal(restored.last_completed_date, '2026-10-01');
    assert.equal(restored.last_completed_estimated, 1);
  } finally { connection.close(); }
});

test('late weather results cannot replace a newer planner snapshot', async () => {
  const { connection, database } = createDatabase();
  try {
    await setup(database);
    await repository.saveWeatherLocation(database, { region: '横浜市', displayName: '横浜市, 神奈川県', latitude: 35.44, longitude: 139.64 });
    const snapshot = await repository.loadPlannerSnapshot(database, '2026-10-24');
    let finishWeather;
    const weatherResult = new Promise((resolve) => { finishWeather = resolve; });
    const pending = repository.applyWeatherToPlannerSnapshot(database, snapshot, () => true, () => weatherResult);
    const newer = await repository.loadPlannerSnapshot(database, '2026-10-25');
    finishWeather({ schedule: [], outcome: 'adjusted', adjustmentCount: 1 });
    assert.equal(await pending, null);
    assert.equal(connection.prepare('SELECT COUNT(*) AS count FROM chore_schedule_entries').get().count, newer.scheduleEntries.length);
  } finally { connection.close(); }
});
