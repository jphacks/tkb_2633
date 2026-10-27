import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { CausalStamp, ManualRuleFact } from './model.ts';
import type { V2DateRequestState } from './request-state.ts';
import { observedConfirmation } from './confirmation.ts';
import { uniqueCausalFacts, maximalCausalFacts } from './causal-facts.ts';
import { validateDesignationTarget } from './date-target.ts';

/** Derived rules are rebuilt locally from source proofs, never accepted as signed operations from a Snapshot. */
export function approvedRequestRule(request: SharedOperation, state: V2DateRequestState, context: { timeZone: string; ruleVersion: number }): ManualRuleFact | null {
  if (state.requestId !== request.operationId || request.entityType !== 'changeRequest' || request.schemaVersion !== 2
    || canonicalJson(state.proposal) !== canonicalJson(request.payload)) throw new Error('Approved state does not belong to this source request');
  if (state.kind !== 'approved') return null;
  if (!state.confirmation) throw new Error('Missing source confirmation evidence');
  const proposal = state.proposal;
  const target = validateDesignationTarget(proposal.proposedMode, state.formal);
  const id = `v2-rule-${sharedDocumentDigest({ groupId: request.groupId, requestId: request.operationId, target,
    mode: proposal.proposedMode, options: proposal.proposedOptions, selector: proposal.selector })}`;
  const basisRuleIds = [...new Set([...(proposal.originalDesignationId ? [proposal.originalDesignationId] : []), ...(proposal.basisRuleIds ?? [])])].sort(compareOperationIds);
  return { operationId: id, authorDeviceId: request.authorDeviceId, deviceSequence: request.deviceSequence, context: { ...request.context },
    sourceRequestId: request.operationId, confirmation: state.confirmation,
    rule: { id, choreId: proposal.choreId, subjectUserId: proposal.subjectUserId, selector: proposal.selector,
      referenceAnchorDate: proposal.anchorDate, timeZoneAtCreation: context.timeZone, ruleVersion: context.ruleVersion,
      mode: proposal.proposedMode, target, ...proposal.proposedOptions, issuerUserId: request.authorUserId, basisRuleIds } };
}
export function observedManualRule(fact: ManualRuleFact, at: CausalStamp): boolean {
  return fact.confirmation ? observedConfirmation(fact.confirmation, at) : causallyPrecedes(fact, at);
}

/** Observing a pending request is insufficient to overwrite its later approval. */
export function maximalManualRules(input: readonly ManualRuleFact[]): ManualRuleFact[] {
  const facts = uniqueCausalFacts(input);
  const causalMaxima = new Set(maximalCausalFacts(facts).map((fact) => fact.operationId));
  const confirmed = new Map(facts.filter((fact) => fact.confirmation).map((fact) => [fact.operationId, fact]));
  const replaced = new Set<string>();
  for (const fact of facts) for (const id of fact.rule.basisRuleIds ?? []) {
    const old = confirmed.get(id);
    if (old?.confirmation && old.operationId !== fact.operationId && observedConfirmation(old.confirmation, fact)) replaced.add(id);
  }
  return facts.filter((fact) => fact.confirmation ? !replaced.has(fact.operationId) : causalMaxima.has(fact.operationId));
}
