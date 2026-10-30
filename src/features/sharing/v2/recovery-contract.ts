import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from '../operations.ts';
import type { SharedSnapshotBase } from '../replica.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { SignedV2RecoveryWitness, V2RecoveryEntry, V2RecoveryPreservedFact } from './recovery-witness.ts';

/** JSON-safe, bounded original event. The invalid envelope is intentionally not decoded here. */
export interface RawV2RecoveryEvent {
  schemaVersion: 2; groupId: string; operationId: string; authorUserId: string; authorDeviceId: string;
  keyVersion: number; uploadSequence: number; envelopeJson: string; authorProofDigest: string; receivedAtMs: number;
}
export const MAX_V2_RECOVERY_SCAN_EVENTS = 10_000;
export const MAX_V2_RECOVERY_SCAN_BYTES = 32 * 1024 * 1024;
export function validateRawV2RecoveryEvent(raw: RawV2RecoveryEvent, groupId: string): RawV2RecoveryEvent {
  assertJsonRecord(raw);
  if (Object.keys(raw).sort().join(',') !== 'authorDeviceId,authorProofDigest,authorUserId,envelopeJson,groupId,keyVersion,operationId,receivedAtMs,schemaVersion,uploadSequence'
    || raw.schemaVersion !== 2 || raw.groupId !== groupId || !Number.isSafeInteger(raw.keyVersion) || raw.keyVersion < 1
    || !Number.isSafeInteger(raw.uploadSequence) || raw.uploadSequence < 1 || typeof raw.envelopeJson !== 'string' || raw.envelopeJson.length > 800_000
    || !/^[a-f0-9]{64}$/u.test(raw.authorProofDigest) || !Number.isSafeInteger(raw.receivedAtMs) || raw.receivedAtMs < 0 || raw.receivedAtMs > 253402300799999) {
    throw new Error('Invalid raw recovery event metadata');
  }
  [raw.groupId, raw.operationId, raw.authorUserId, raw.authorDeviceId].forEach(assertSharedIdentifier);
  return JSON.parse(canonicalJson(raw));
}
export interface V2RecoveryReview {
  id: string; groupId: string; reviewDigest: string; previousRosterDigest: string; baselineSequence: number; throughSequence: number;
  retainedChanges: number; unreadableChanges: number; heldChanges: number; restoredOriginals: number;
  removeDeviceIds: string[]; removeUserIds: string[];
  entries: V2RecoveryEntry[];
}
export interface V2RecoveryDraft {
  review: V2RecoveryReview;
  baselineIndexDigest: string;
  baselineBase: SharedSnapshotBase;
  rawEvents: RawV2RecoveryEvent[];
  receipts: V2ServerReceipt[];
  /** Original signed values remain on-device; no unconfirmed local fact is published as accepted work. */
  preservedFacts: V2RecoveryPreservedFact[];
  readyFacts: AuthenticatedSharedOperation[];
  retainedBase: SharedSnapshotBase;
  createdAtMs: number;
}
export interface V2RecoveryProof {
  witness: SignedV2RecoveryWitness;
  originals: RawV2RecoveryEvent[];
}
export class V2RecoveryStaleError extends Error { readonly code = 'sharing/recovery-review-stale'; }
export class V2RecoveryLimitError extends Error { readonly code = 'sharing/recovery-limit'; }
export class V2RecoveryOriginalRequiredError extends Error { readonly code = 'sharing/recovery-original-required'; }
