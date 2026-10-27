import { canonicalJson, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { CausalStamp } from './model.ts';
import { assertSharedIdentifier } from '../identifier.ts';

/** All alternatives are retained; a quorum never expands into a Cartesian product of votes. */
export type ConfirmationProof = { kind: 'operation'; operationId: string; authorDeviceId: string; deviceSequence: number }
  | { kind: 'all' | 'any'; entries: ConfirmationProof[] };
export function observedConfirmation(proof: ConfirmationProof, at: CausalStamp): boolean {
  if (proof.kind === 'operation') {
    assertSharedIdentifier(proof.operationId); assertSharedIdentifier(proof.authorDeviceId);
    if (!Number.isSafeInteger(proof.deviceSequence) || proof.deviceSequence <= 0) throw new Error('Invalid confirmation dot');
    return ((at.receiptContext ?? at.context)[proof.authorDeviceId] ?? 0) >= proof.deviceSequence;
  }
  if (!['all', 'any'].includes(proof.kind) || !Array.isArray(proof.entries) || !proof.entries.length) throw new Error('Empty or invalid confirmation');
  return proof.kind === 'all' ? proof.entries.every((part) => observedConfirmation(part, at)) : proof.entries.some((part) => observedConfirmation(part, at));
}
export function combineConfirmations(kind: 'all' | 'any', entries: readonly ConfirmationProof[]): ConfirmationProof {
  const unique = [...new Map(entries.map((entry) => [canonicalJson(entry), entry])).entries()]
    .sort(([a], [b]) => compareOperationIds(a, b)).map(([, entry]) => entry);
  if (!unique.length) throw new Error('A confirmation requires an actual signed fact');
  if (unique.length > 128) {
    const pages: ConfirmationProof[] = [];
    for (let offset = 0; offset < unique.length; offset += 128) pages.push(combineConfirmations(kind, unique.slice(offset, offset + 128)));
    return combineConfirmations(kind, pages);
  }
  return unique.length === 1 ? unique[0] : { kind, entries: unique };
}
export function confirmationOf(op: SharedOperation): ConfirmationProof {
  return { kind: 'operation', operationId: op.operationId, authorDeviceId: op.authorDeviceId, deviceSequence: op.deviceSequence };
}

