import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { CausalStamp, ManualRuleFact } from './model.ts';
import type { V2DateRequestState } from './request-state.ts';
import { observedConfirmation } from './confirmation.ts';
import { maximalConfirmedFacts } from './confirmed-facts.ts';
import { validateDesignationTarget } from './date-target.ts';

/** Derived rules are rebuilt locally from source proofs, never accepted as signed operations from a Snapshot. */
export function approvedRequestRule(request: SharedOperation, state: V2DateRequestState, context: { timeZone: string; ruleVersion: number }): ManualRuleFact | null {
  if (state.requestId !== request.operationId || request.entityType !== 'changeRequest' || request.schemaVersion !== 2
    || canonicalJson(state.proposal) !== canonicalJson(request.payload)) throw new Error('Approved state does not belong to this source request');
  if (state.kind !== 'approved') return null;
  if (!state.formal) throw new Error('Approved request must contain an actual formal date');
  if (!state.confirmation) throw new Error('Missing source confirmation evidence');
  const proposal = state.proposal;
  const target = validateDesignationTarget(proposal.proposedMode, state.formal);
  const id = approvedRequestRuleId(request, target);
  const basisRuleIds = [...new Set([...(proposal.originalDesignationId ? [proposal.originalDesignationId] : []), ...(proposal.basisRuleIds ?? [])])].sort(compareOperationIds);
  return { operationId: id, authorDeviceId: request.authorDeviceId, deviceSequence: request.deviceSequence, context: { ...request.context },
    sourceRequestId: request.operationId, confirmation: state.confirmation,
    rule: { id, choreId: proposal.choreId, subjectUserId: proposal.subjectUserId, selector: proposal.selector,
      referenceAnchorDate: proposal.anchorDate, timeZoneAtCreation: context.timeZone, ruleVersion: context.ruleVersion,
      mode: proposal.proposedMode, target, ...proposal.proposedOptions, issuerUserId: request.authorUserId, basisRuleIds,
      ...(proposal.reviewedRequestIds ? { reviewedRequestIds: [...proposal.reviewedRequestIds] } : {}) } };
}
/** Identity calculation does not establish approval; only approvedRequestRule supplies evidence. */
export function approvedRequestRuleId(request: SharedOperation, target: import('./model.ts').DateTarget): string {
  const proposal = request.payload as unknown as import('./model.ts').DateChangeRequest;
  return `v2-rule-${sharedDocumentDigest({ groupId: request.groupId, requestId: request.operationId, target: validateDesignationTarget(proposal.proposedMode, target),
    mode: proposal.proposedMode, options: proposal.proposedOptions, selector: proposal.selector })}`;
}
export function observedManualRule(fact: ManualRuleFact, at: CausalStamp): boolean {
  return fact.confirmation ? observedConfirmation(fact.confirmation, at) : causallyPrecedes(fact, at);
}

/** Observing a pending request is insufficient to overwrite its later approval. */
export function maximalManualRules(input: readonly ManualRuleFact[]): ManualRuleFact[] {
  return maximalConfirmedFacts(input, (fact) => fact.rule.basisRuleIds ?? []);
}
