import type { SharedOperation } from '../operations.ts';
import type { ManualRule, ManualRuleFact, RuleSelector } from './model.ts';
import { observedDateCancellations } from './date-cancellations.ts';
import type { V2HistoryView } from './history-view.ts';
import { observedManualRule } from './formal-rules.ts';

export function observedDateRules(view: V2HistoryView, operation: SharedOperation, approved: readonly ManualRuleFact[] = [], includeCancelled = false): ManualRuleFact[] {
  const rules = [...view.observed(view.ofType('designation'), operation)
    .map((fact) => ({ ...fact, rule: fact.payload.configuration as unknown as ManualRule }) as ManualRuleFact),
  ...approved.filter((fact) => observedManualRule(fact, operation))];
  if (includeCancelled) return rules;
  const cancellations = observedDateCancellations(view, operation);
  const cancelled = new Set(cancellations.filter((fact) => !fact.selector).flatMap((fact) => fact.targetOperationIds));
  const excluded = new Map<string, RuleSelector[]>();
  for (const fact of cancellations) {
    if (!fact.selector) continue;
    for (const id of fact.targetOperationIds) {
      const selectors = excluded.get(id) ?? []; selectors.push(fact.selector); excluded.set(id, selectors);
    }
  }
  return rules.filter((fact) => !cancelled.has(fact.operationId))
    .map((fact) => excluded.has(fact.operationId) ? { ...fact, excludedSelectors: excluded.get(fact.operationId)! } : fact);
}
