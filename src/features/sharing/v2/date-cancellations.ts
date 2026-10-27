import type { SharedOperation } from '../operations.ts';
import type { ManualRule, RuleSelector, SharedOccurrence } from './model.ts';
import { ruleSelectorMatches } from './period-rules.ts';

/** A scoped removal starts on a verified round of the source rule, never on an invented ID. */
export function cancellationScopeMatches(rule: ManualRule, selector: RuleSelector, frame: SharedOccurrence): boolean {
  const from = selector.scope === 'once' ? selector.anchorDate : selector.scope === 'period' ? selector.range.from : selector.from;
  return from === frame.anchorDate && rule.choreId === frame.choreId && rule.ruleVersion === frame.ruleVersion
    && (selector.scope !== 'once' || selector.occurrenceId === frame.id) && ruleSelectorMatches(rule.selector, frame);
}
export function dateRuleCancelledAt(cancellations: readonly SharedOperation[], operationId: string, frame: SharedOccurrence): boolean {
  return cancellations.some((op) => (op.payload.targetOperationIds as string[]).includes(operationId)
    && (!op.payload.selector || ruleSelectorMatches(op.payload.selector as unknown as RuleSelector, frame)));
}
