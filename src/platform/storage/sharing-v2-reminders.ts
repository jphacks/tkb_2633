import type { SQLiteDatabase } from 'expo-sqlite';
import { withSharingLedgerTransaction } from './sharing-ledger.ts';
import { validateV2ReminderPreferences } from '../../features/sharing/v2/reminders.ts';
import type { V2ReminderPreferences } from '../../features/sharing/v2/reminders';

export interface V2ReminderControl { revision: number; preferences: V2ReminderPreferences; groupRevision: string | null }

/** Device-local preferences. Never projected, signed, copied into an outbox or saved in the personal/v1 DB. */
export function createV2ReminderStore(database: SQLiteDatabase, scope: { userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  async function check(transaction: SQLiteDatabase) {
    await scope.assertAccess();
    const row = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id, group_id, schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (row?.user_id !== scope.userId || row.group_id !== scope.groupId || row.schema_version !== 2) throw new Error('共有通知のアカウント・保存先が変わりました。');
    await scope.assertAccess();
  }
  async function readInside(transaction: SQLiteDatabase): Promise<V2ReminderControl> {
    await check(transaction);
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_reminders (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      revision INTEGER NOT NULL CHECK(revision>0), preferences_json TEXT NOT NULL);`);
    const row = await transaction.getFirstAsync<{ user_id: string; group_id: string; revision: number; preferences_json: string }>('SELECT * FROM sharing_v2_private_reminders WHERE singleton=1');
    const group = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
    if (row && (row.user_id !== scope.userId || row.group_id !== scope.groupId || !Number.isSafeInteger(row.revision) || row.revision < 1)) throw new Error('共有通知の設定を確認してください。');
    const preferences = row ? validateV2ReminderPreferences(JSON.parse(row.preferences_json)) : { enabled: false, hour: 9, minute: 0 };
    await check(transaction); return { revision: row?.revision ?? 0, preferences, groupRevision: group?.fact_hash ?? null };
  }
  return {
    read: () => withSharingLedgerTransaction(database, readInside),
    save(expectedRevision: number, value: V2ReminderPreferences) {
      const preferences = validateV2ReminderPreferences(value);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return Promise.reject(new Error('共有通知の設定を読み直してください。'));
      return withSharingLedgerTransaction(database, async transaction => {
        const before = await readInside(transaction);
        if (before.revision === expectedRevision + 1 && JSON.stringify(before.preferences) === JSON.stringify(preferences)) return before;
        if (before.revision !== expectedRevision) throw new Error('別の操作で通知設定が変わりました。読み直してください。');
        if (JSON.stringify(before.preferences) === JSON.stringify(preferences)) return before;
        if (!Number.isSafeInteger(before.revision + 1)) throw new Error('通知設定の保存版を確認してください。');
        await check(transaction);
        await transaction.runAsync(`INSERT INTO sharing_v2_private_reminders VALUES (1, ?, ?, ?, ?)
          ON CONFLICT(singleton) DO UPDATE SET revision=excluded.revision, preferences_json=excluded.preferences_json`, scope.userId, scope.groupId, before.revision + 1, JSON.stringify(preferences));
        await check(transaction); return { ...before, revision: before.revision + 1, preferences };
      });
    },
  };
}
export type V2ReminderStore = ReturnType<typeof createV2ReminderStore>;
