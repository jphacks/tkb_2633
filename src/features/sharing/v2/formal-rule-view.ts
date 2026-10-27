import type { SharedOperation } from '../operations.ts';
import type { ManualRule, ManualRuleFact } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { observedManualRule } from './formal-rules.ts';

export function observedDateRules(view: V2HistoryView, operation: SharedOperation, approved: readonly ManualRuleFact[] = [], includeCancelled = false): ManualRuleFact[] {
  const rules = [...view.observed(view.ofType('designation'), operation)
    .map((fact) => ({ ...fact, rule: fact.payload.configuration as unknown as ManualRule }) as ManualRuleFact),
  ...approved.filter((fact) => observedManualRule(fact, operation))];
  if (includeCancelled) return rules;
  const cancelled = new Set(view.observed(view.ofType('designationCancel'), operation).flatMap((fact) => fact.payload.targetOperationIds as string[]));
  return rules.filter((fact) => !cancelled.has(fact.operationId));
}
