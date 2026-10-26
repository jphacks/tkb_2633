import type { SQLiteDatabase } from 'expo-sqlite';
import type { GoogleTaskStatus } from '../../features/google-sync/contracts.ts';

/** Caller supplies the transaction and revision; completion storage and Google queue staging stay atomic. */
export async function stagePendingGoogleTaskStatus(database: SQLiteDatabase, scheduleEntryId: string, status: GoogleTaskStatus, revision: string): Promise<void> {
  await database.runAsync('UPDATE google_task_links SET pending_status = ?, pending_status_revision = ? WHERE schedule_entry_id = ?', status, revision, scheduleEntryId);
}
