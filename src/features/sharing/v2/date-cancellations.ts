import type { SharedOperation } from '../operations.ts';
import type { DateRuleCancellation, ManualRule, RuleSelector, SharedOccurrence } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { ruleSelectorMatches } from './period-rules.ts';

/** A scoped removal starts on a verified round of the source rule, never on an invented ID. */
export function cancellationScopeMatches(rule: ManualRule, selector: RuleSelector, frame: SharedOccurrence): boolean {
  const from = selector.scope === 'once' ? selector.anchorDate : selector.scope === 'period' ? selector.range.from : selector.from;
  return from === frame.anchorDate && rule.choreId === frame.choreId && rule.ruleVersion === frame.ruleVersion
    && (selector.scope !== 'once' || selector.occurrenceId === frame.id) && ruleSelectorMatches(rule.selector, frame);
}
export function observedDateCancellations(view: V2HistoryView, at?: SharedOperation): DateRuleCancellation[] {
  const direct = at ? view.observed(view.ofType('designationCancel'), at) : view.ofType('designationCancel');
  return [...direct.map((op) => ({ targetOperationIds: op.payload.targetOperationIds as string[], selector: op.payload.selector as unknown as RuleSelector ?? null })),
    ...view.dateCancellationsAt(at)];
}
export function dateRuleCancelledAt(cancellations: readonly DateRuleCancellation[], operationId: string, frame: SharedOccurrence): boolean {
  return cancellations.some((entry) => entry.targetOperationIds.includes(operationId)
    && (!entry.selector || ruleSelectorMatches(entry.selector, frame)));
}
