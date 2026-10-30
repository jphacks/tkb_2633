import { Timestamp } from 'firebase/firestore';
import { validateV2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';

/** Invoke only on getDoc(s)FromServer results, never a pending local write, a snapshot payload or Date.now(). */
export function parseV2FirestoreReceipt(raw: unknown, groupId: string, operationId: string): V2ServerReceipt {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Missing committed server receipt');
  const record = raw as Record<string, unknown>;
  if (Object.keys(record).sort().join(',') !== 'authorDeviceId,authorProofDigest,authorUserId,createdAt,keyVersion,schemaVersion,uploadSequence'
    || !(record.createdAt instanceof Timestamp)) throw new Error('A receipt needs an actual committed Firestore timestamp');
  return validateV2ServerReceipt({ schemaVersion: record.schemaVersion as 2, groupId, operationId,
    authorUserId: record.authorUserId as string, authorDeviceId: record.authorDeviceId as string,
    receivedKeyVersion: record.keyVersion as number, uploadSequence: record.uploadSequence as number,
    authorProofDigest: record.authorProofDigest as string, receivedAtMs: Math.floor(record.createdAt.toMillis()) });
}
