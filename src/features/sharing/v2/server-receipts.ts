import { assertSharedIdentifier, canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import { sharedAuthorIdentity } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';

export interface V2ServerReceipt {
  schemaVersion: 2;
  groupId: string;
  operationId: string;
  authorUserId: string;
  authorDeviceId: string;
  receivedKeyVersion: number;
  uploadSequence: number;
  authorProofDigest: string;
  receivedAtMs: number;
}
export function validateV2ServerReceipt(input: V2ServerReceipt): V2ServerReceipt {
  if (!input || typeof input !== 'object' || Object.keys(input).sort().join(',')
    !== 'authorDeviceId,authorProofDigest,authorUserId,groupId,operationId,receivedAtMs,receivedKeyVersion,schemaVersion,uploadSequence'
    || input.schemaVersion !== 2) throw new Error('Invalid v2 server receipt');
  [input.groupId, input.operationId, input.authorUserId, input.authorDeviceId].forEach(assertSharedIdentifier);
  if (![input.receivedKeyVersion, input.uploadSequence].every((value) => Number.isSafeInteger(value) && value > 0)
    || !Number.isSafeInteger(input.receivedAtMs) || input.receivedAtMs < 0 || input.receivedAtMs > 253402300799999
    || !/^[a-f0-9]{64}$/u.test(input.authorProofDigest)) throw new Error('Invalid v2 receipt metadata');
  return JSON.parse(canonicalJson(input)) as V2ServerReceipt;
}

/** Commit the authenticated fact, including its hidden signature, rather than exposing a plaintext dictionary hash. */
export function v2AuthorProofDigest(fact: AuthenticatedSharedOperation): string { return sharedDocumentDigest(fact); }

/** The receipt's immutable timestamp is accepted only after matching its original signed fact and delivery membership. */
export function bindV2ServerReceipt(raw: V2ServerReceipt, fact: AuthenticatedSharedOperation, archive: readonly VerifiedSharedRoster[]): VerifiedSharedRoster {
  const receipt = validateV2ServerReceipt(raw); const op = fact.operation;
  if (op.schemaVersion !== 2 || receipt.groupId !== op.groupId || receipt.operationId !== op.operationId
    || receipt.authorUserId !== op.authorUserId || receipt.authorDeviceId !== op.authorDeviceId
    || receipt.authorProofDigest !== v2AuthorProofDigest(fact) || receipt.receivedKeyVersion < op.keyVersion) throw new Error('Server receipt does not match the original author proof');
  const receivedEpoch = archive[receipt.receivedKeyVersion - 1];
  if (!receivedEpoch || receivedEpoch.body.groupId !== op.groupId || receivedEpoch.body.keyVersion !== receipt.receivedKeyVersion
    || receivedEpoch.body.schemaVersion !== 2) throw new Error('Missing original server receipt membership');
  sharedAuthorIdentity(receivedEpoch, op.authorUserId, op.authorDeviceId, op.keyVersion);
  return receivedEpoch;
}
