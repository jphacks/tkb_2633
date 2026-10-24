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

test('schema migration creates local appliance snapshots, notification preference, and occurrence visibility storage', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 7);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all().map((column) => column.name);
    assert.equal(settingsColumns.includes('notifications_enabled'), true);
    const applianceColumns = connection.prepare('PRAGMA table_info(appliances)').all().map((column) => column.name);
    assert.deepEqual(applianceColumns, [
      'id', 'household_id', 'manufacturer', 'product_name', 'model_number', 'category', 'display_name',
      'official_product_url', 'official_manual_url', 'analysis_json', 'created_at', 'updated_at',
    ]);
    const hiddenColumns = connection.prepare('PRAGMA table_info(hidden_waste_occurrences)').all();
    assert.equal(hiddenColumns.find((column) => column.name === 'schedule_id').pk, 1);
    assert.equal(hiddenColumns.find((column) => column.name === 'occurrence_date').pk, 2);
  } finally {
    connection.close();
  }
});

test('version 6 migration tolerates a notification preference column already present in an existing database', async () => {
  const { connection, database } = sqliteAdapter();
  try {
    await migrateLocalDatabase(database);
    connection.exec('PRAGMA user_version = 6');

    await migrateLocalDatabase(database);

    assert.equal(connection.prepare('PRAGMA user_version').get().user_version, 7);
    const settingsColumns = connection.prepare('PRAGMA table_info(household_settings)').all();
    assert.equal(settingsColumns.filter((column) => column.name === 'notifications_enabled').length, 1);
    assert.equal(connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'appliances'").get().name, 'appliances');
  } finally {
    connection.close();
  }
});
