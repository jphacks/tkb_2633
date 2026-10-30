import type { SQLiteDatabase } from 'expo-sqlite';

/** Native transactions use their own connection so unrelated private writes cannot join them. */
export async function withIsolatedSqliteTransaction<T>(database: SQLiteDatabase, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
  let result!: T;
  if (database.withExclusiveTransactionAsync) {
    await database.withExclusiveTransactionAsync(async (transaction) => { result = await work(transaction); });
  } else {
    await database.withTransactionAsync(async () => { result = await work(database); });
  }
  return result;
}
