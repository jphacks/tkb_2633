import type { SQLiteDatabase } from 'expo-sqlite';

const INITIAL_SCHEMA_VERSION = 1;

export async function migrateLocalDatabase(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  const currentVersion = versionRow?.user_version ?? 0;

  if (currentVersion >= INITIAL_SCHEMA_VERSION) {
    return;
  }

  await database.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS households (
      id TEXT PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS household_members (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      display_name TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chore_definitions (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      definition_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chore_assignments (
      chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
      member_id TEXT NOT NULL REFERENCES household_members(id) ON DELETE CASCADE,
      PRIMARY KEY (chore_id, member_id)
    );

    CREATE TABLE IF NOT EXISTS chore_dependencies (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      predecessor_chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
      successor_chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
      policy_json TEXT
    );

    CREATE TABLE IF NOT EXISTS chore_schedule_entries (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
      window_start TEXT NOT NULL,
      window_end TEXT NOT NULL,
      suggested_date TEXT NOT NULL,
      status TEXT NOT NULL,
      entry_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chore_completions (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      chore_id TEXT NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
      completed_at TEXT NOT NULL,
      completed_by_member_id TEXT REFERENCES household_members(id) ON DELETE SET NULL,
      source TEXT
    );

    CREATE TABLE IF NOT EXISTS weekly_waste_schedules (
      id TEXT PRIMARY KEY NOT NULL,
      household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      weekdays_json TEXT NOT NULL,
      metadata_json TEXT
    );

    CREATE TABLE IF NOT EXISTS sync_outbox (
      id TEXT PRIMARY KEY NOT NULL,
      change_type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending'
    );
  `);

  await database.execAsync(`PRAGMA user_version = ${INITIAL_SCHEMA_VERSION}`);
}
