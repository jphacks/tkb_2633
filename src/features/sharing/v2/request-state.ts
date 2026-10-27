import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { approvalDeadline } from './approval-deadline.ts';
import type { ApprovalDeadline } from './approval-deadline.ts';
import { normalizeDateTarget, validateDesignationTarget } from './date-target.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { DateChangeRequest, DateTarget } from './model.ts';
import type { DateChangePermission } from './permissions.ts';

import { combineConfirmations as combine, confirmationOf as proofOf } from './confirmation.ts';
import type { ConfirmationProof } from './confirmation.ts';
export { observedConfirmation } from './confirmation.ts';
export type { ConfirmationProof } from './confirmation.ts';

type Decision = 'approve' | 'reject' | 'counteroffer' | 'acceptCounteroffer';
type AuditKind = 'eligible' | 'pendingDelivery' | 'late' | 'unauthorized' | 'invalidCausality' | 'requestClosed' | 'staleCounteroffer';
interface DecisionNode { op: SharedOperation; receipt: V2ServerReceipt; decision: Decision; target: DateTarget | null; offerId: string | null }
interface Choice { target: DateTarget; proof: ConfirmationProof; confirmedAt: number }
interface Summary {
  kind: 'awaiting' | 'counteroffered' | 'approved' | 'rejected' | 'conflict';
  choices: Choice[]; offers: DecisionNode[]; conflictIds: string[];
}
export interface V2DateRequestState {
  requestId: string;
  kind: Summary['kind'] | 'pendingDelivery' | 'tooLate' | 'expired' | 'blocked';
  original: DateTarget;
  formal: DateTarget;
  proposal: DateChangeRequest;
  deadline: ApprovalDeadline;
  confirmation: ConfirmationProof | null;
  confirmedAt: number | null;
  counteroffers: { operationId: string; target: DateTarget; expiresAt: number }[];
  conflictIds: string[];
  decisions: { operationId: string; kind: AuditKind }[];
}

/**
 * Inputs are authenticated, business-authorized source facts and independently fetched receipts.
 * The owner's Snapshot, a device timestamp, or an optimistic local decision is not a receipt.
 * confirmedServerTime is optional and may only come from trusted server evidence, never Date.now().
 */
export function deriveV2DateRequest(input: {
  request: AuthenticatedSharedOperation;
  decisions: readonly AuthenticatedSharedOperation[];
  receipts: ReadonlyMap<string, V2ServerReceipt>;
  archive: readonly VerifiedSharedRoster[];
  context: { permission: DateChangePermission; assigneeIds: readonly string[]; timeZone: string };
  confirmedServerTime?: number;
}): V2DateRequestState {
  const request = input.request.operation;
  if (request.schemaVersion !== 2 || request.entityType !== 'changeRequest') throw new Error('Expected an authenticated v2 date request');
  const proposal = request.payload as unknown as DateChangeRequest;
  const original = normalizeDateTarget(proposal.original);
  const proposed = validateDesignationTarget(proposal.proposedMode, proposal.proposed);
  const requestReceipt = input.receipts.get(request.operationId);
  const deadline = approvalDeadline({ serverRequestedAt: requestReceipt?.receivedAtMs ?? null,
    original, proposed, timeZone: input.context.timeZone });
  const result: V2DateRequestState = { requestId: request.operationId, kind: 'pendingDelivery', original, formal: original,
    proposal, deadline, confirmation: null, confirmedAt: null, counteroffers: [], conflictIds: [], decisions: [] };
  if (!requestReceipt) return result;
  bindV2ServerReceipt(requestReceipt, input.request, input.archive);
  if (deadline.kind !== 'open') return { ...result, kind: deadline.kind };
  if (input.context.permission.kind === 'denied') return { ...result, kind: 'blocked' };
  if (input.confirmedServerTime !== undefined && !Number.isSafeInteger(input.confirmedServerTime)) throw new Error('Invalid confirmed server time');
  const automatic = input.context.permission.kind === 'allowed';
  const assigneeConsent = input.context.permission.kind === 'approvalRequired' && input.context.permission.approver === 'assignee';
  const requiredMembers = [...new Set(input.context.assigneeIds)].sort(compareOperationIds);
  if (assigneeConsent && !requiredMembers.length) throw new Error('Missing affected assignees');
  const recipients = assigneeConsent ? requiredMembers : [request.authorUserId];
  const facts = new Map<string, AuthenticatedSharedOperation>();
  for (const fact of input.decisions) {
    const previous = facts.get(fact.operation.operationId);
    if (previous && canonicalJson(previous) !== canonicalJson(fact)) throw new Error('Conflicting original decision proof');
    facts.set(fact.operation.operationId, fact);
  }
  const nodes: DecisionNode[] = [];
  const audit = new Map<string, AuditKind>();
  let serverTime = Math.max(requestReceipt.receivedAtMs, input.confirmedServerTime ?? requestReceipt.receivedAtMs);
  for (const fact of facts.values()) {
    const op = fact.operation;
    if (op.schemaVersion !== 2 || op.groupId !== request.groupId || op.entityType !== 'requestDecision' || op.payload.requestId !== request.operationId) {
      throw new Error('Decision belongs to another request');
    }
    const receipt = input.receipts.get(op.operationId);
    if (!receipt) { audit.set(op.operationId, 'pendingDelivery'); continue; }
    const epoch = bindV2ServerReceipt(receipt, fact, input.archive);
    serverTime = Math.max(serverTime, receipt.receivedAtMs);
    if (!causallyPrecedes(request, op) || receipt.uploadSequence <= requestReceipt.uploadSequence || receipt.receivedAtMs < requestReceipt.receivedAtMs) {
      audit.set(op.operationId, 'invalidCausality'); continue;
    }
    const decision = op.payload.decision as Decision;
    const admin = op.authorUserId === epoch.body.ownerUserId;
    if (decision === 'counteroffer' ? !admin : decision === 'acceptCounteroffer' ? !recipients.includes(op.authorUserId)
      : assigneeConsent ? !requiredMembers.includes(op.authorUserId) : !admin) {
      audit.set(op.operationId, 'unauthorized'); continue;
    }
    const target = decision === 'counteroffer' ? validateDesignationTarget(proposal.proposedMode, op.payload.target as unknown as DateTarget) : null;
    const limit = target ? offerDeadline(target) : deadline.expiresAt;
    if (receipt.receivedAtMs > limit) { audit.set(op.operationId, 'late'); continue; }
    nodes.push({ op, receipt, decision, target, offerId: op.payload.referenceDecisionId as string | null });
  }
  // Reception order is only a topological traversal, never a winner selection rule.
  nodes.sort((a, b) => a.receipt.uploadSequence - b.receipt.uploadSequence || compareOperationIds(a.op.operationId, b.op.operationId));
  const eligible: DecisionNode[] = [];
  for (const node of nodes) {
    const observed = eligible.filter((prior) => causallyPrecedes(prior.op, node.op));
    const prior = summarize(observed);
    if (automatic || prior.kind === 'approved' || prior.kind === 'rejected') { audit.set(node.op.operationId, 'requestClosed'); continue; }
    if (node.decision === 'acceptCounteroffer') {
      const offer = observed.find((candidate) => candidate.op.operationId === node.offerId && candidate.decision === 'counteroffer');
      if (!offer || node.receipt.uploadSequence <= offer.receipt.uploadSequence || node.receipt.receivedAtMs < offer.receipt.receivedAtMs) {
        audit.set(node.op.operationId, 'invalidCausality'); continue;
      }
      if (node.receipt.receivedAtMs > offerDeadline(offer.target!)) { audit.set(node.op.operationId, 'late'); continue; }
      const latest = latestNodes(observed.filter((candidate) => candidate.decision === 'counteroffer'));
      if (!latest.some((candidate) => keyOf(candidate.target!) === keyOf(offer.target!))) {
        audit.set(node.op.operationId, 'staleCounteroffer'); continue;
      }
    }
    eligible.push(node); audit.set(node.op.operationId, 'eligible');
  }
  result.decisions = [...audit].sort(([a], [b]) => compareOperationIds(a, b)).map(([operationId, kind]) => ({ operationId, kind }));
  if (automatic) return { ...result, kind: 'approved', formal: proposed, confirmation: proofOf(request), confirmedAt: requestReceipt.receivedAtMs };
  const summary = summarize(eligible);
  result.counteroffers = summary.offers.map((node) => ({ operationId: node.op.operationId, target: node.target!, expiresAt: offerDeadline(node.target!) }));
  result.conflictIds = summary.conflictIds;
  if (summary.kind === 'approved') {
    return { ...result, kind: 'approved', formal: summary.choices[0].target,
      confirmation: combine('all', [proofOf(request), combine('any', summary.choices.map((choice) => choice.proof))]),
      confirmedAt: Math.min(...summary.choices.map((choice) => choice.confirmedAt)) };
  }
  if (summary.kind !== 'rejected' && serverTime > deadline.expiresAt) return { ...result, kind: 'expired' };
  return { ...result, kind: summary.kind };

  function keyOf(target: DateTarget): string { return canonicalJson(normalizeDateTarget(target)); }
  function offerDeadline(target: DateTarget): number {
    const alternative = approvalDeadline({ serverRequestedAt: requestReceipt!.receivedAtMs, original, proposed: target, timeZone: input.context.timeZone });
    return alternative.kind === 'open' ? Math.min(deadline.kind === 'open' ? deadline.expiresAt : -Infinity, alternative.expiresAt) : -Infinity;
  }
  function latestNodes(values: readonly DecisionNode[]): DecisionNode[] {
    const byId = new Map(values.map((node) => [node.op.operationId, node]));
    return maximalCausalFacts(values.map((node) => node.op)).map((op) => byId.get(op.operationId)!);
  }
  function summarize(values: readonly DecisionNode[]): Summary {
    const byId = new Map(values.map((node) => [node.op.operationId, node]));
    const offers = latestNodes(values.filter((node) => node.decision === 'counteroffer'));
    const votes = values.filter((node) => node.decision !== 'counteroffer');
    const memberVotes = new Map([...new Set(votes.map((node) => node.op.authorUserId))].map((uid) =>
      [uid, latestNodes(votes.filter((node) => node.op.authorUserId === uid))]));
    const normalCohorts = assigneeConsent ? requiredMembers.map((uid) => memberVotes.get(uid) ?? [])
      : [latestNodes(values.filter((node) => node.decision !== 'acceptCounteroffer'))];
    const recipientCohorts = recipients.map((uid) => memberVotes.get(uid) ?? []);
    const conflictIds = new Set<string>();
    const choiceOf = (node: DecisionNode): string => node.decision === 'reject' ? 'reject'
      : node.decision === 'approve' ? keyOf(proposed) : node.decision === 'counteroffer' ? `offer:${keyOf(node.target!)}`
        : keyOf(byId.get(node.offerId!)!.target!);
    for (const cohort of [...normalCohorts, ...recipientCohorts]) {
      if (new Set(cohort.map(choiceOf)).size > 1) cohort.forEach((node) => conflictIds.add(node.op.operationId));
    }
    const choices: Choice[] = [];
    const normalVotes = normalCohorts.map((cohort) => cohort.filter((node) => node.decision === 'approve'));
    if (normalVotes.every((cohort) => cohort.length > 0)) choices.push({ target: proposed,
      proof: combine('all', normalVotes.map((cohort) => combine('any', cohort.map((node) => proofOf(node.op))))),
      confirmedAt: Math.max(...normalVotes.map((cohort) => Math.min(...cohort.map((node) => node.receipt.receivedAtMs)))) });
    for (const offer of offers) {
      const offerVotes = recipientCohorts.map((cohort) => cohort.filter((node) => node.decision === 'acceptCounteroffer'
        && keyOf(byId.get(node.offerId!)!.target!) === keyOf(offer.target!)));
      if (offerVotes.every((cohort) => cohort.length > 0)) choices.push({ target: offer.target!,
        proof: combine('all', offerVotes.map((cohort) => combine('any', cohort.map((node) =>
          combine('all', [proofOf(byId.get(node.offerId!)!.op), proofOf(node.op)]))))),
        confirmedAt: Math.max(...offerVotes.map((cohort) => Math.min(...cohort.map((node) => node.receipt.receivedAtMs)))) });
    }
    // A concurrent replacement offer cannot silently invalidate a target someone already accepted.
    for (const node of votes.filter((candidate) => candidate.decision === 'acceptCounteroffer')) {
      const offer = byId.get(node.offerId!)!;
      if (!offers.some((current) => keyOf(current.target!) === keyOf(offer.target!))) {
        conflictIds.add(node.op.operationId); offers.forEach((current) => conflictIds.add(current.op.operationId));
      }
    }
    const rejected = normalCohorts.some((cohort) => cohort.some((node) => node.decision === 'reject'));
    if (new Set(choices.map((choice) => keyOf(choice.target))).size > 1 || rejected && choices.length) {
      values.forEach((node) => conflictIds.add(node.op.operationId));
    }
    return { kind: conflictIds.size ? 'conflict' : rejected ? 'rejected' : choices.length ? 'approved'
      : offers.length ? 'counteroffered' : 'awaiting', choices, offers,
    conflictIds: [...conflictIds].sort(compareOperationIds) };
  }
}
