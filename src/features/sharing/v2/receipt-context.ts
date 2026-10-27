import type { SharedOperation, VersionVector } from '../operations.ts';
import type { V2ServerReceipt } from './server-receipts.ts';

/** Knowing a pending signed operation is distinct from having fetched its immutable server receipt. */
export function v2ReceiptWasObserved(source: SharedOperation, at: SharedOperation): boolean {
  return ((at.receiptContext ?? at.context)[source.authorDeviceId] ?? 0) >= source.deviceSequence;
}
export function v2ObservedReceipts(sources: readonly SharedOperation[], at: SharedOperation, receipts: ReadonlyMap<string, V2ServerReceipt>): ReadonlyMap<string, V2ServerReceipt> {
  if (at.receiptContext === undefined) return receipts;
  const observed = new Map<string, V2ServerReceipt>();
  for (const source of sources) { const receipt = receipts.get(source.operationId); if (receipt && v2ReceiptWasObserved(source, at)) observed.set(source.operationId, receipt); }
  return observed;
}
export function v2ConfirmedReceiptContext(operations: readonly SharedOperation[], receipts: ReadonlyMap<string, V2ServerReceipt>): VersionVector {
  const context: VersionVector = {};
  for (const op of operations) if (receipts.has(op.operationId)) context[op.authorDeviceId] = Math.max(context[op.authorDeviceId] ?? 0, op.deviceSequence);
  return context;
}
