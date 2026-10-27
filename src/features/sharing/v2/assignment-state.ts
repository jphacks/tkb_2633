import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { V2HistoryView } from './history-view.ts';
import type { AssignmentChangeRequest, CausalStamp, ManualRuleFact, SharedOccurrence } from './model.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import { approvalDeadline } from './approval-deadline.ts';
import type { ApprovalDeadline } from './approval-deadline.ts';
import { confirmationOf, combineConfirmations } from './confirmation.ts';
import type { ConfirmationProof } from './confirmation.ts';
import { recordedInstructionAt } from './recorded-instruction.ts';
import { targetReferenceTime } from './date-target.ts';
import { v2ObservedReceipts } from './receipt-context.ts';

export interface V2AssignmentFact extends CausalStamp {
  payload: { choreId: string; memberIds: string[]; fromOccurrenceId: string; fromAnchorDate: string; scope: 'once' | 'from'; fixed: boolean; ruleVersion: number;
    basisRuleIds?: string[]; reviewedAssignmentRequestIds?: string[] };
  confirmation?: ConfirmationProof; sourceRequestId?: string;
}
export interface V2AssignmentRequestState {
  requestId: string; kind: 'pendingDelivery' | 'awaiting' | 'expired' | 'tooLate' | 'approved' | 'rejected' | 'conflict';
  proposal: AssignmentChangeRequest; deadline: ApprovalDeadline; confirmation: ConfirmationProof | null;
  cancelled: boolean;
  decisions: { operationId: string; kind: 'pendingDelivery' | 'late' | 'requestClosed' | 'eligible' }[]; conflictIds: string[];
}
export interface V2AssignmentProjection { facts: V2AssignmentFact[]; requests: V2AssignmentRequestState[] }
type Evidence = { facts: ReadonlyMap<string, AuthenticatedSharedOperation>; receipts: ReadonlyMap<string, V2ServerReceipt> };

/** Derived facts retain original request causality and separate receipt-backed confirmation. They are never signed or uploaded. */
export function createV2AssignmentHistory(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], evidence?: Evidence) {
  let generation = -1; const cache = new Map<string, V2AssignmentProjection>();
  let serverTime = 0; for (const receipt of evidence?.receipts.values() ?? []) serverTime = Math.max(serverTime, receipt.receivedAtMs);
  return (at: SharedOperation): V2AssignmentProjection => {
    if (generation !== view.ready.length) { cache.clear(); generation = view.ready.length; }
    const key = canonicalJson([at.keyVersion, at.context, at.receiptContext ?? null]); const known = cache.get(key); if (known) return known;
    const cancelled = observedV2AssignmentCancellations(view, at);
    const facts: V2AssignmentFact[] = view.observed(view.ofType('assignmentRule'), at).filter((op) => !cancelled.has(op.operationId))
      .map((op) => ({ ...op, payload: op.payload as unknown as V2AssignmentFact['payload'] }));
    const requests: V2AssignmentRequestState[] = [];
    const decisions = new Map<string, SharedOperation[]>();
    for (const op of view.observed(view.ofType('assignmentDecision'), at)) {
      const id = op.payload.requestId as string; const entries = decisions.get(id) ?? []; entries.push(op); decisions.set(id, entries);
    }
    for (const op of view.observed(view.ofType('assignmentRequest'), at)) {
      const answers = decisions.get(op.operationId) ?? [];
      const state = { ...deriveV2AssignmentRequest(op, answers, archive, evidence ? { ...evidence, receipts: v2ObservedReceipts([op, ...answers], at, evidence.receipts) } : undefined, serverTime), cancelled: cancelled.has(op.operationId) }; requests.push(state);
      if (state.kind !== 'approved' || state.cancelled) continue;
      facts.push({ ...op, operationId: approvedV2AssignmentId(op), confirmation: state.confirmation!, sourceRequestId: op.operationId,
        payload: { choreId: state.proposal.choreId, memberIds: state.proposal.memberIds, fromOccurrenceId: state.proposal.occurrenceId,
          fromAnchorDate: state.proposal.anchorDate, scope: state.proposal.scope, fixed: state.proposal.fixed, ruleVersion: state.proposal.ruleVersion,
          basisRuleIds: state.proposal.originalAssignmentIds } });
    }
    const result = { facts, requests }; cache.set(key, result);
    while (cache.size > 256) cache.delete(cache.keys().next().value!); return result;
  };
}

export function observedV2AssignmentCancellations(view: V2HistoryView, at: SharedOperation): ReadonlySet<string> {
  return new Set(view.observed(view.ofType('assignmentCancel'), at).flatMap((op) => op.payload.targetOperationIds as string[]));
}

export function approvedV2AssignmentId(request: SharedOperation): string {
  return `v2-assignment-${sharedDocumentDigest({ groupId: request.groupId, requestId: request.operationId, proposal: request.payload })}`;
}

export function v2AssignmentRequestReference(view: V2HistoryView, at: SharedOperation, frame: SharedOccurrence, subjectIds: readonly string[], formalRules: readonly ManualRuleFact[]) {
  const instructions = (subjectIds.length ? subjectIds : [null]).map((subject) => recordedInstructionAt(view, at, frame, subject, formalRules));
  if (instructions.some((instruction) => instruction.kind === 'unconfirmed')) throw new Error('日時を確認してから担当変更を申請してください。');
  const timeZone = instructions[0].timeZone;
  const targets = instructions.map((instruction) => instruction.kind === 'designated' ? instruction.target : { precision: 'date' as const, date: frame.anchorDate });
  return { reference: targets.sort((a, b) => targetReferenceTime(a, timeZone) - targetReferenceTime(b, timeZone))[0], timeZone };
}

export function deriveV2AssignmentRequest(request: SharedOperation, input: readonly SharedOperation[], archive: readonly VerifiedSharedRoster[], evidence?: Evidence,
  confirmedServerTime = 0): V2AssignmentRequestState {
  if (request.entityType !== 'assignmentRequest' || request.schemaVersion !== 2) throw new Error('Expected an assignment change request');
  const proposal = request.payload as unknown as AssignmentChangeRequest;
  const receipt = evidence?.receipts.get(request.operationId);
  const deadline = approvalDeadline({ serverRequestedAt: receipt?.receivedAtMs ?? null, original: proposal.reference, proposed: proposal.reference, timeZone: proposal.timeZone });
  const result: V2AssignmentRequestState = { requestId: request.operationId, kind: 'pendingDelivery', proposal, deadline, confirmation: null, cancelled: false, decisions: [], conflictIds: [] };
  if (!receipt || !evidence) return result;
  const proof = evidence.facts.get(request.operationId); if (!proof) throw new Error('Missing assignment request author proof'); bindV2ServerReceipt(receipt, proof, archive);
  if (deadline.kind !== 'open') return { ...result, kind: deadline.kind };
  const terminal: SharedOperation[] = []; const closed = new Map<string, number>();
  for (const op of [...input].sort((a, b) => a.logicalClock - b.logicalClock || compareOperationIds(a.operationId, b.operationId))) {
    if (op.entityType !== 'assignmentDecision' || op.payload.requestId !== request.operationId || !causallyPrecedes(request, op)) throw new Error('Assignment decision does not observe its source request');
    const answerReceipt = evidence.receipts.get(op.operationId);
    if (!answerReceipt) { result.decisions.push({ operationId: op.operationId, kind: 'pendingDelivery' }); continue; }
    const answer = evidence.facts.get(op.operationId); if (!answer) throw new Error('Missing assignment decision proof');
    const epoch = bindV2ServerReceipt(answerReceipt, answer, archive);
    if (epoch.body.ownerUserId !== op.authorUserId) throw new Error('Only the delivery-epoch administrator may approve an assignment');
    if (answerReceipt.uploadSequence <= receipt.uploadSequence || answerReceipt.receivedAtMs < deadline.requestedAt) throw new Error('Invalid assignment receipt order');
    if (answerReceipt.receivedAtMs > deadline.expiresAt) { result.decisions.push({ operationId: op.operationId, kind: 'late' }); continue; }
    if ([...closed].some(([device, sequence]) => (op.context[device] ?? 0) >= sequence)) {
      result.decisions.push({ operationId: op.operationId, kind: 'requestClosed' }); continue;
    }
    closed.set(op.authorDeviceId, Math.min(closed.get(op.authorDeviceId) ?? op.deviceSequence, op.deviceSequence));
    terminal.push(op); result.decisions.push({ operationId: op.operationId, kind: 'eligible' });
  }
  const kinds = new Set(terminal.map((op) => op.payload.decision));
  if (kinds.size > 1) return { ...result, kind: 'conflict', conflictIds: terminal.map((op) => op.operationId).sort(compareOperationIds) };
  if (terminal.length && terminal[0].payload.decision === 'approve') return { ...result, kind: 'approved',
    confirmation: combineConfirmations('all', [confirmationOf(request), combineConfirmations('any', terminal.map(confirmationOf))]) };
  if (terminal.length) return { ...result, kind: 'rejected' };
  return { ...result, kind: confirmedServerTime > deadline.expiresAt ? 'expired' : 'awaiting' };
}
