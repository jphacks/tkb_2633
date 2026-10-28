import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedLocalDate } from '../group-clock.ts';
import type { V2HistoryView } from './history-view.ts';
import type { ManualRuleFact, SharedOccurrence } from './model.ts';
import type { V2DateRequestState } from './request-state.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { targetCivilDate, instantMilliseconds } from './date-target.ts';
import type { ConfirmationProof } from './confirmation.ts';
import type { SharedOperation } from '../operations.ts';
import { dateRuleCancelledAt, observedDateCancellations } from './date-cancellations.ts';

function administratorBacked(proof: ConfirmationProof | null, view: V2HistoryView, epochs: ReadonlyMap<string, VerifiedSharedRoster>): boolean {
  if (!proof) return false;
  if (proof.kind !== 'operation') return proof.entries.some((part) => administratorBacked(part, view, epochs));
  const source = view.byId(proof.operationId); const epoch = epochs.get(proof.operationId);
  return Boolean(source && epoch && source.authorUserId === epoch.body.ownerUserId);
}
/** The common window expands only with an administrator-backed approval, never with someone's private recommendation. */
export function expandedCommonWindow(input: { frame: SharedOccurrence; timeZone: string; view: V2HistoryView;
  requests: readonly V2DateRequestState[]; approvedRules: readonly ManualRuleFact[]; receiptEpochs: ReadonlyMap<string, VerifiedSharedRoster>; at?: SharedOperation }) {
  let before = daysBetween(input.frame.windowStart, input.frame.anchorDate); let after = daysBetween(input.frame.anchorDate, input.frame.windowEnd);
  const sources: string[] = []; const reviews: string[] = [];
  const cancellations = observedDateCancellations(input.view, input.at);
  const byRequest = new Map(input.approvedRules.map((rule) => [rule.sourceRequestId, rule]));
  for (const request of input.requests) {
    if (request.kind !== 'approved' || !request.formal || request.proposal.choreId !== input.frame.choreId) continue;
    const rule = byRequest.get(request.requestId); if (!rule || dateRuleCancelledAt(cancellations, rule.operationId, input.frame) || rule.rule.ruleVersion !== input.frame.ruleVersion) continue;
    if (request.proposal.extensionScope === 'once' ? request.proposal.occurrenceId !== input.frame.id : request.proposal.anchorDate > input.frame.anchorDate) continue;
    if (!administratorBacked(request.confirmation, input.view, input.receiptEpochs)) continue;
    const sourceZone = rule.rule.timeZoneAtCreation;
    const start = targetCivilDate(request.formal, sourceZone);
    const end = request.formal.precision === 'interval' ? sharedLocalDate(new Date(instantMilliseconds(request.formal.end)), sourceZone) : start;
    before = Math.max(before, -daysBetween(request.proposal.anchorDate, start)); after = Math.max(after, daysBetween(request.proposal.anchorDate, end));
    sources.push(request.requestId);
  }
  try { return { windowStart: addDays(input.frame.anchorDate, -before), windowEnd: addDays(input.frame.anchorDate, after), sources: sources.sort(), reviews: reviews.sort() }; }
  catch { return { windowStart: input.frame.windowStart, windowEnd: input.frame.windowEnd, sources: [], reviews: [...new Set([...reviews, ...sources])].sort() }; }
}
