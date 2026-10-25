import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

import { createDatabase } from './helpers/sqlite.mjs';
const { migrateLocalDatabase } = await import('../src/platform/storage/migrations.ts');
const {
  deleteGoogleTaskLink,
  listEntriesForGoogleSync,
  listGoogleTaskLinks,
  loadGoogleSyncState,
  saveGoogleSyncState,
  upsertGoogleTaskLink,
} = await import('../src/platform/storage/repository.ts');

const householdId = 'home';
const now = '2026-10-25T00:00:00.000Z';

async function setup() {
  const store = createDatabase();
  await migrateLocalDatabase(store.database);
  await store.database.runAsync(
    'INSERT INTO households (id, name, created_at) VALUES (?, ?, ?)', householdId, 'Home', now,
  );
  return store;
}

function chore(id, name, enabled = true) {
  const definition = { id, householdId, name, enabled };
  return definition;
}

function entry(id, choreId, suggestedDate, status = 'scheduled') {
  return {
    id,
    householdId,
    choreId,
    cycleBaseDate: suggestedDate,
    windowStart: suggestedDate,
    windowEnd: suggestedDate,
    suggestedDate,
    status,
    assignedMemberIds: [],
  };
}

test('Google sync state is saved and loaded without placing tokens in SQLite', async () => {
  const { connection, database } = await setup();
  try {
    const state = {
      householdId,
      enabled: true,
      taskListId: 'list-1',
      lastAttemptAt: now,
      lastSuccessfulSyncAt: now,
      status: 'idle',
      retryCount: 0,
      updatedAt: now,
    };
    await saveGoogleSyncState(database, state);
    assert.deepEqual(await loadGoogleSyncState(database, householdId), state);
    const columns = connection.prepare('PRAGMA table_info(google_sync_state)').all().map((column) => column.name);
    assert.equal(columns.some((name) => /token/iu.test(name)), false);
  } finally {
    connection.close();
  }
});

test('sync entries include future and overdue enabled chores while excluding initial-pending and obsolete rows', async () => {
  const { connection, database } = await setup();
  try {
    const chores = [chore('today', '今日の家事'), chore('overdue', '期限超過'), chore('future', '次の予定'), chore('old', '古い予定'), chore('initial', '初回保留'), chore('disabled', '無効', false)];
    for (const definition of chores) {
      await database.runAsync(
        'INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, ?, ?)',
        definition.id, householdId, definition.name, definition.enabled ? 1 : 0, JSON.stringify(definition),
      );
    }
    const entries = [
      entry('entry-today', 'today', '2026-10-25'),
      entry('entry-overdue', 'overdue', '2026-10-24', 'overdue'),
      entry('entry-future', 'future', '2026-10-26'),
      entry('entry-old', 'old', '2026-10-24'),
      entry('entry-initial', 'initial', '2026-10-25', 'initialPending'),
      entry('entry-disabled', 'disabled', '2026-10-25'),
    ];
    for (const scheduleEntry of entries) {
      await database.runAsync(
        `INSERT INTO chore_schedule_entries
         (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        scheduleEntry.id, householdId, scheduleEntry.choreId, scheduleEntry.windowStart, scheduleEntry.windowEnd,
        scheduleEntry.suggestedDate, scheduleEntry.status, JSON.stringify(scheduleEntry),
      );
    }
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      'completion-today', householdId, 'today', now, 'inApp', 'entry-today',
    );

    const result = await listEntriesForGoogleSync(database, '2026-10-25', householdId);
    assert.deepEqual(result.map(({ entry: row }) => row.id).sort(), ['entry-future', 'entry-overdue', 'entry-today']);
    assert.equal(result.find(({ entry: row }) => row.id === 'entry-today').completedAt, now);
    assert.equal(result.find(({ entry: row }) => row.id === 'entry-future').choreName, '次の予定');
  } finally {
    connection.close();
  }
});

test('Google task links support stable upsert and explicit deletion', async () => {
  const { connection, database } = await setup();
  try {
    const link = {
      scheduleEntryId: 'entry-1',
      householdId,
      choreId: 'chore-1',
      googleTaskListId: 'list-1',
      googleTaskId: 'task-1',
      lastSyncedTitle: '掃除',
      lastSyncedDueDate: '2026-10-26',
      createdAt: now,
      updatedAt: now,
    };
    await upsertGoogleTaskLink(database, link);
    await upsertGoogleTaskLink(database, { ...link, lastSyncedTitle: '洗濯', updatedAt: '2026-10-26T00:00:00.000Z' });
    assert.deepEqual(await listGoogleTaskLinks(database, householdId), [
      { ...link, lastSyncedTitle: '洗濯', updatedAt: '2026-10-26T00:00:00.000Z' },
    ]);
    await deleteGoogleTaskLink(database, link.scheduleEntryId);
    assert.deepEqual(await listGoogleTaskLinks(database, householdId), []);
  } finally {
    connection.close();
  }
});

test('a linked completion stays in the sync input after schedule regeneration removes its row', async () => {
  const { connection, database } = await setup();
  try {
    await database.runAsync(
      'INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, 0, ?)',
      'completed-chore', householdId, '完了した家事', JSON.stringify(chore('completed-chore', '完了した家事', false)),
    );
    await upsertGoogleTaskLink(database, {
      scheduleEntryId: 'completed-entry',
      householdId,
      choreId: 'completed-chore',
      googleTaskListId: 'list-1',
      googleTaskId: 'task-1',
      createdAt: now,
      updatedAt: now,
    });
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome, scheduled_date,
        scheduled_window_start, scheduled_window_end)
       VALUES (?, ?, ?, ?, ?, ?, 'completed', ?, ?, ?)`,
      'completion-1', householdId, 'completed-chore', now, 'inApp', 'completed-entry',
      '2026-10-20', '2026-10-19', '2026-10-21',
    );

    const result = await listEntriesForGoogleSync(database, '2026-10-25', householdId);
    assert.equal(result.length, 1);
    assert.equal(result[0].entry.id, 'completed-entry');
    assert.equal(result[0].entry.suggestedDate, '2026-10-20');
    assert.equal(result[0].choreName, '完了した家事');
    assert.equal(result[0].completedAt, now);
  } finally {
    connection.close();
  }
});

test('a completed linked entry is retained for remote completion even after its chore is disabled', async () => {
  const { connection, database } = await setup();
  try {
    await database.runAsync(
      'INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, 0, ?)',
      'disabled-completed', householdId, '無効にした完了済み家事', JSON.stringify(chore('disabled-completed', '無効にした完了済み家事', false)),
    );
    const scheduleEntry = entry('disabled-completed-entry', 'disabled-completed', '2026-10-20');
    await database.runAsync(
      `INSERT INTO chore_schedule_entries
       (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      scheduleEntry.id, householdId, scheduleEntry.choreId, scheduleEntry.windowStart, scheduleEntry.windowEnd,
      scheduleEntry.suggestedDate, scheduleEntry.status, JSON.stringify(scheduleEntry),
    );
    await upsertGoogleTaskLink(database, {
      scheduleEntryId: scheduleEntry.id,
      householdId,
      choreId: scheduleEntry.choreId,
      googleTaskListId: 'list-1',
      googleTaskId: 'task-1',
      createdAt: now,
      updatedAt: now,
    });
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, source, schedule_entry_id, outcome)
       VALUES (?, ?, ?, ?, ?, ?, 'completed')`,
      'disabled-completion', householdId, scheduleEntry.choreId, now, 'inApp', scheduleEntry.id,
    );

    const result = await listEntriesForGoogleSync(database, '2026-10-25', householdId);
    assert.equal(result.length, 1);
    assert.equal(result[0].entry.id, scheduleEntry.id);
    assert.equal(result[0].completedAt, now);
  } finally {
    connection.close();
  }
});
