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
      async withTransactionAsync(callback) {
        connection.exec('BEGIN');
        try { await callback(); connection.exec('COMMIT'); }
        catch (error) { connection.exec('ROLLBACK'); throw error; }
      },
    },
  };
}

test('schema migration creates the latest local planner and Google sync schema', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
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
      'last_synced_status', 'pending_status', 'pending_status_revision',
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

    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
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

test('failure during an old schema upgrade rolls back its DDL and version and can be retried', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    const exec = database.execAsync;
    database.execAsync = async (sql) => {
      if (sql.includes('CREATE INDEX IF NOT EXISTS idx_completions_household_completed')) throw new Error('interrupted migration');
      return exec(sql);
    };
    await assert.rejects(migrateLocalDatabase(database), /interrupted migration/);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 0);
    assert.equal(connection.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table'").get().n, 0);
    database.execAsync = exec;
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
  } finally { connection.close(); }
});

test('concurrent migrations on one connection join the same transaction', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await Promise.all([migrateLocalDatabase(database), migrateLocalDatabase(database), migrateLocalDatabase(database)]);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
  } finally { connection.close(); }
});

test('a failed v16 status-column migration leaves no partially added columns', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec(`ALTER TABLE google_task_links DROP COLUMN last_synced_status;
      ALTER TABLE google_task_links DROP COLUMN pending_status;
      ALTER TABLE google_task_links DROP COLUMN pending_status_revision;
      ALTER TABLE household_settings DROP COLUMN planner_calendar_signature;
      PRAGMA user_version = 15;`);
    const exec = database.execAsync;
    database.execAsync = async (sql) => {
      if (sql.includes('ADD COLUMN pending_status ')) throw new Error('interrupted status migration');
      return exec(sql);
    };
    await assert.rejects(migrateLocalDatabase(database), /interrupted status migration/);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 15);
    assert.ok(!connection.prepare('PRAGMA table_info(google_task_links)').all().some((column) => column.name === 'last_synced_status'));
    database.execAsync = exec;
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
  } finally { connection.close(); }
});

test('a transient SQLite busy error retries the complete migration', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    const exec = database.execAsync; let failures = 0;
    database.execAsync = async (sql) => {
      if (sql.includes('PRAGMA busy_timeout') && failures++ === 0) throw new Error('SQLITE_BUSY: database is locked');
      return exec(sql);
    };
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 16);
    assert.equal(failures, 2);
  } finally { connection.close(); }
});
