import type { SQLiteDatabase } from 'expo-sqlite';
import { privateCalendarDatabaseFilename } from '../../features/sharing/private-calendar/database-name.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';

export interface PrivateCalendarDatabaseConnection {
  readonly kind: 'private-calendar'; readonly ownerUserId: string; readonly filename: string;
  readonly development: boolean; readonly database: SQLiteDatabase;
}
const busy = (error: unknown) => error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database (?:table )?is locked/iu.test(error.message);
const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

/** The protected key vault and later ciphertext ledger share one process-safe SQLite writer lock. */
export function createPrivateCalendarExclusiveStorage(connection: PrivateCalendarDatabaseConnection) {
  if (connection.kind !== 'private-calendar' || connection.filename !== privateCalendarDatabaseFilename(connection.ownerUserId, connection.development)) throw new Error('本人専用のDB接続が必要です。');
  const { database, ownerUserId } = connection; let initialized = false; let tail: Promise<unknown> = Promise.resolve();
  async function scope(db: SQLiteDatabase) {
    const row = await db.getFirstAsync<{ owner_user_id: string; schema_version: number }>('SELECT owner_user_id, schema_version FROM private_calendar_scope WHERE id = ?', 'scope');
    if (!row || row.owner_user_id !== ownerUserId || row.schema_version !== 1) throw new Error('本人専用DBのアカウントが一致しません。');
  }
  async function run<T>(expectedUserId: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
    if (expectedUserId !== ownerUserId) throw new Error('本人専用DBの接続先が変わりました。');
    for (let attempt = 0; ; attempt++) {
      let entered = false;
      try {
        if (!initialized) {
          await database.execAsync(`PRAGMA busy_timeout = 50;
            CREATE TABLE IF NOT EXISTS private_calendar_scope (
              id TEXT PRIMARY KEY NOT NULL CHECK (id = 'scope'), owner_user_id TEXT NOT NULL,
              schema_version INTEGER NOT NULL CHECK (schema_version = 1), lock_toggle INTEGER NOT NULL CHECK (lock_toggle IN (0, 1))
            );`);
          await database.runAsync('INSERT OR IGNORE INTO private_calendar_scope (id, owner_user_id, schema_version, lock_toggle) VALUES (?, ?, 1, 0)', 'scope', ownerUserId);
          await scope(database); initialized = true;
        }
        return await withIsolatedSqliteTransaction(database, async (transaction) => {
          await transaction.execAsync('PRAGMA busy_timeout = 50;');
          const locked = await transaction.runAsync('UPDATE private_calendar_scope SET lock_toggle = 1 - lock_toggle WHERE id = ? AND owner_user_id = ?', 'scope', ownerUserId);
          if (locked.changes !== 1) throw new Error('本人専用DBをロックできません。');
          await scope(transaction); entered = true;
          return work(transaction);
        });
      } catch (error) {
        // Never replay a callback that may already have committed to SecureStore.
        if (entered || !busy(error) || attempt >= 49) throw error;
        await pause();
      }
    }
  }
  return {
    exclusive<T>(userId: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
      const pending = tail.then(() => run(userId, work), () => run(userId, work));
      tail = pending.then(() => undefined, () => undefined); return pending;
    },
  };
}
