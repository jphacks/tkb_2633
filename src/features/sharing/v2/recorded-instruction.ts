import type { SharedOperation } from '../operations.ts';
import type { V2HistoryView } from './history-view.ts';
import type { ManualRuleFact, RecordedInstruction, SharedOccurrence } from './model.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { selectManualRule } from './period-rules.ts';
import { materializeRuleTarget } from './rule-target.ts';

/** This value is recorded with the work; later assignments and instructions cannot rewrite it. */
export function recordedInstructionAt(view: V2HistoryView, operation: SharedOperation, occurrence: SharedOccurrence,
  subjectUserId: string | null, approved: readonly ManualRuleFact[]): RecordedInstruction {
  const timeZone = view.field('settings', 'settings', 'timeZone', operation)?.value;
  if (typeof timeZone !== 'string') throw new Error('Missing recorded instruction timezone');
  const selected = selectManualRule(observedDateRules(view, operation, approved), occurrence, subjectUserId, timeZone);
  if (selected.kind === 'automatic') return { kind: 'automatic', timeZone };
  if (selected.kind === 'conflict') return { kind: 'unconfirmed', reason: 'dateConflict', timeZone };
  const target = materializeRuleTarget(selected.fact.rule, occurrence, timeZone);
  if (target.kind === 'review') return { kind: 'unconfirmed', reason: target.reason, timeZone };
  return { kind: 'designated', ruleId: selected.fact.operationId, mode: selected.fact.rule.mode, target: target.target,
    strict: selected.fact.rule.strict, timeZone };
}
