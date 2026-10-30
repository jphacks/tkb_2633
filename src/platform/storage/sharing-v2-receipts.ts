import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { validateV2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';

export async function initializeV2ReceiptTable(transaction: SQLiteDatabase): Promise<void> {
  await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_server_receipts (
    group_id TEXT NOT NULL, operation_id TEXT NOT NULL, receipt_json TEXT NOT NULL,
    PRIMARY KEY(group_id, operation_id));`);
}
/** This is transaction-local evidence from the server adapter, never a server timestamp copied from an owner snapshot. */
export async function persistV2ServerReceiptsInside(transaction: SQLiteDatabase, groupId: string, input: readonly V2ServerReceipt[]): Promise<boolean> {
  if (input.length > 10_000) throw new Error('Receipt page exceeds the local recovery budget');
  let changed = false;
  for (const raw of input) {
    const receipt = validateV2ServerReceipt(raw); if (receipt.groupId !== groupId) throw new Error('Foreign receipt');
    const encoded = canonicalJson(receipt);
    const existing = await transaction.getFirstAsync<{ receipt_json: string }>('SELECT receipt_json FROM sharing_v2_server_receipts WHERE group_id=? AND operation_id=?', groupId, receipt.operationId);
    if (existing && existing.receipt_json !== encoded) throw new Error('An immutable server receipt changed');
    if (existing) continue;
    await transaction.runAsync('INSERT INTO sharing_v2_server_receipts VALUES (?, ?, ?)', groupId, receipt.operationId, encoded); changed = true;
  }
  return changed;
}
export async function readV2ServerReceiptsInside(transaction: SQLiteDatabase, groupId: string): Promise<Map<string, V2ServerReceipt>> {
  const rows = await transaction.getAllAsync<{ receipt_json: string }>('SELECT receipt_json FROM sharing_v2_server_receipts WHERE group_id=? ORDER BY operation_id', groupId);
  const receipts = rows.map((row) => validateV2ServerReceipt(JSON.parse(row.receipt_json)));
  if (receipts.some((receipt) => receipt.groupId !== groupId)) throw new Error('Stored receipt belongs to another group');
  return new Map(receipts.map((receipt) => [receipt.operationId, receipt]));
}
