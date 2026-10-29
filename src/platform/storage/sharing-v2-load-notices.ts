import type { SQLiteDatabase } from 'expo-sqlite';
import { withSharingLedgerTransaction } from './sharing-ledger.ts';
import { parseLocalDate } from '../../domain/scheduling/local-date.ts';
import type { V2ReminderControl } from './sharing-v2-reminders';
import type { LocalDate } from '../../domain/shared/types';

/** Private at-most-once marker per owner/group/day. It is never an event or completion history. */
export function createV2LoadNoticeStore(database: SQLiteDatabase, scope: { userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const check = async (transaction: SQLiteDatabase) => {
    await scope.assertAccess();
    const binding = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id,group_id,schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (binding?.user_id !== scope.userId || binding.group_id !== scope.groupId || binding.schema_version !== 2) throw new Error('負荷通知の本人・保存先が変わりました。');
    await scope.assertAccess();
  };
  async function seen(transaction: SQLiteDatabase, date: LocalDate) {
    parseLocalDate(date); await check(transaction);
    if (!await transaction.getFirstAsync("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sharing_v2_private_load_notices'")) return false;
    const row = await transaction.getFirstAsync<{ user_id: string; group_id: string }>('SELECT user_id,group_id FROM sharing_v2_private_load_notices WHERE date=?', date);
    if (row && (row.user_id !== scope.userId || row.group_id !== scope.groupId)) throw new Error('負荷通知の本人を確認してください。');
    await check(transaction); return Boolean(row);
  }
  return {
    seen: (date: LocalDate) => withSharingLedgerTransaction(database, transaction => seen(transaction, date)),
    claim(date: LocalDate, revision: string, control: Pick<V2ReminderControl, 'revision' | 'groupRevision'>, guard: () => Promise<void>) {
      if (!/^[a-f0-9]{64}$/u.test(revision)) return Promise.reject(new Error('負荷の確認内容を読み直してください。'));
      return withSharingLedgerTransaction(database, async transaction => {
        await guard(); if (await seen(transaction, date)) return false;
        const preferences = await transaction.getFirstAsync<{ revision: number }>('SELECT revision FROM sharing_v2_private_reminders WHERE singleton=1');
        const group = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
        if ((preferences?.revision ?? 0) !== control.revision || (group?.fact_hash ?? null) !== control.groupRevision) throw new Error('負荷通知の設定・予定が変わりました。');
        await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_load_notices (
          date TEXT PRIMARY KEY, user_id TEXT NOT NULL, group_id TEXT NOT NULL, assessment_hash TEXT NOT NULL);`);
        await transaction.runAsync('INSERT INTO sharing_v2_private_load_notices VALUES (?,?,?,?)', date, scope.userId, scope.groupId, revision);
        await guard(); await check(transaction); return true;
      });
    },
  };
}
export type V2LoadNoticeStore = ReturnType<typeof createV2LoadNoticeStore>;
