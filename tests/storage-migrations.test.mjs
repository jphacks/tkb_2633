import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';

function sqliteAdapter() {
  const connection = new DatabaseSync(':memory:');
  return {
    connection,
    database: {
      async execAsync(sql) { connection.exec(sql); },
      async runAsync(sql, ...params) { return connection.prepare(sql).run(...params); },
      async getFirstAsync(sql, ...params) { return connection.prepare(sql).get(...params) ?? null; },
      async getAllAsync(sql, ...params) { return connection.prepare(sql).all(...params); },
    },
  };
}

test('schema migration creates the latest local planner and Google sync schema', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 14);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all().map((column) => column.name);
    assert.equal(settingsColumns.includes('notifications_enabled'), true);
    assert.equal(settingsColumns.includes('built_in_chore_catalog_version'), true);
    const applianceColumns = connection.prepare('PRAGMA table_info(appliances)').all().map((column) => column.name);
    assert.deepEqual(applianceColumns, [
      'id', 'household_id', 'manufacturer', 'product_name', 'model_number', 'category', 'display_name',
      'official_product_url', 'official_manual_url', 'analysis_json', 'created_at', 'updated_at',
    ]);
    const hiddenColumns = connection.prepare('PRAGMA table_info(hidden_waste_occurrences)').all();
    assert.equal(hiddenColumns.find((column) => column.name === 'schedule_id').pk, 1);
    assert.equal(hiddenColumns.find((column) => column.name === 'occurrence_date').pk, 2);
    const completionColumns = connection.prepare('PRAGMA table_info(chore_completions)').all().map((column) => column.name);
    assert.equal(completionColumns.includes('scheduled_date'), true);
    assert.equal(completionColumns.includes('scheduled_window_start'), true);
    assert.equal(completionColumns.includes('scheduled_window_end'), true);
    const syncStateColumns = connection.prepare('PRAGMA table_info(google_sync_state)').all().map((column) => column.name);
    assert.deepEqual(syncStateColumns, [
      'household_id', 'enabled', 'task_list_id', 'last_attempt_at', 'last_successful_sync_at', 'status',
      'retry_count', 'next_retry_at', 'last_error_code', 'last_error_at', 'updated_at',
    ]);
    const taskLinkColumns = connection.prepare('PRAGMA table_info(google_task_links)').all().map((column) => column.name);
    assert.deepEqual(taskLinkColumns, [
      'schedule_entry_id', 'household_id', 'chore_id', 'google_task_list_id', 'google_task_id',
      'last_synced_title', 'last_synced_due_date', 'created_at', 'updated_at',
    ]);
  } finally {
    connection.close();
  }
});

test('version 6 migration tolerates a notification preference column already present in an existing database', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      DROP INDEX IF EXISTS idx_completions_household_scheduled;
      DROP TABLE hidden_waste_occurrences;
      DROP TABLE appliances;
      ALTER TABLE chore_completions DROP COLUMN previous_chore_state_json;
      ALTER TABLE chore_completions DROP COLUMN scheduled_window_end;
      ALTER TABLE chore_completions DROP COLUMN scheduled_window_start;
      ALTER TABLE chore_completions DROP COLUMN scheduled_date;
      PRAGMA user_version = 6;
    `);

    await migrateLocalDatabase(database);

    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 14);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all();
    assert.equal(settingsColumns.filter((column) => column.name === 'notifications_enabled').length, 1);
    assert.equal(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appliances'").get().name, 'appliances');
    const completionColumns = connection.prepare('PRAGMA table_info(chore_completions)').all().map((column) => column.name);
    assert.equal(completionColumns.filter((column) => column === 'scheduled_date').length, 1);
    assert.equal(completionColumns.includes('scheduled_window_start'), true);
    assert.equal(completionColumns.includes('scheduled_window_end'), true);
    assert.equal(completionColumns.filter((column) => column === 'previous_chore_state_json').length, 1);
  } finally {
    connection.close();
  }
});

test('Google task mappings survive local schedule and chore deletion for remote cleanup', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`
      INSERT INTO households (id, name, created_at) VALUES ('home', 'Home', '2026-10-25T00:00:00.000Z');
      INSERT INTO chore_definitions (id, household_id, name, enabled, definition_json)
      VALUES ('chore', 'home', '掃除', 1, '{}');
      INSERT INTO chore_schedule_entries
        (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
      VALUES ('entry', 'home', 'chore', '2026-10-25', '2026-10-25', '2026-10-25', 'scheduled', '{}');
      INSERT INTO google_task_links
        (schedule_entry_id, household_id, chore_id, google_task_list_id, google_task_id, created_at, updated_at)
      VALUES ('entry', 'home', 'chore', 'list', 'task', '2026-10-25T00:00:00.000Z', '2026-10-25T00:00:00.000Z');
      DELETE FROM chore_schedule_entries WHERE id = 'entry';
      DELETE FROM chore_definitions WHERE id = 'chore';
    `);
    assert.equal(connection.prepare('SELECT google_task_id FROM google_task_links WHERE schedule_entry_id = ?').get('entry').google_task_id, 'task');
  } finally {
    connection.close();
  }
});
