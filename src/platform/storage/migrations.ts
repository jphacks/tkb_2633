import type { SQLiteDatabase } from 'expo-sqlite';

const INITIAL_SCHEMA_VERSION = 1;
const CURRENT_SCHEMA_VERSION = 4;

export async function migrateLocalDatabase(database: SQLiteDatabase): Promise<void> {
  const versionRow = await database.getFirstAsync<{ user_version: number }>('PRAGMA user_version');
  let version = versionRow?.user_version ?? 0;

  await database.execAsync(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

  if (version < INITIAL_SCHEMA_VERSION) {
    await database.execAsync(`
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
    version = INITIAL_SCHEMA_VERSION;
  }

  if (version < 2) {
    await database.execAsync(`
      ALTER TABLE chore_completions ADD COLUMN schedule_entry_id TEXT;

      CREATE TABLE IF NOT EXISTS household_settings (
        household_id TEXT PRIMARY KEY NOT NULL REFERENCES households(id) ON DELETE CASCADE,
        frequency_mode TEXT NOT NULL DEFAULT 'balanced',
        rest_days_json TEXT NOT NULL DEFAULT '[6,7]',
        heavy_daily_limit INTEGER NOT NULL DEFAULT 1,
        normal_daily_limit INTEGER NOT NULL DEFAULT 2,
        notification_hour INTEGER NOT NULL DEFAULT 9,
        notification_minute INTEGER NOT NULL DEFAULT 0,
        setup_completed INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS chore_state (
        chore_id TEXT PRIMARY KEY NOT NULL REFERENCES chore_definitions(id) ON DELETE CASCADE,
        last_completed_date TEXT,
        last_completed_estimated INTEGER NOT NULL DEFAULT 0,
        initial_pending INTEGER NOT NULL DEFAULT 1,
        unknown_reason TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_schedule_household_suggested
        ON chore_schedule_entries(household_id, suggested_date);
      CREATE INDEX IF NOT EXISTS idx_completions_household_completed
        ON chore_completions(household_id, completed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_dependencies_successor
        ON chore_dependencies(successor_chore_id);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_completion_schedule_entry
        ON chore_completions(schedule_entry_id);
    `);
    await database.execAsync('PRAGMA user_version = 2');
    version = 2;
  }

  if (version < 3) {
    await database.execAsync(`
      ALTER TABLE chore_state ADD COLUMN initial_scheduled_date TEXT;
      PRAGMA user_version = 3;
    `);
    version = 3;
  }

  if (version < CURRENT_SCHEMA_VERSION) {
    await database.execAsync(`
      ALTER TABLE chore_completions ADD COLUMN outcome TEXT NOT NULL DEFAULT 'completed';
      PRAGMA user_version = ${CURRENT_SCHEMA_VERSION};
    `);
  }
}
