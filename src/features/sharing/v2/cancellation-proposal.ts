import { canonicalJson } from '../operations.ts';
import type { DateRuleCancellation, DateTarget, DesignationMode, DesignationOptions, ManualRuleFact, RuleSelector, SharedOccurrence } from './model.ts';
import { cancellationScopeMatches } from './date-cancellations.ts';
import { selectManualRule } from './period-rules.ts';
import { materializeRuleTarget } from './rule-target.ts';
import { targetReferenceTime } from './date-target.ts';

export function v2CancellationSelector(rules: readonly ManualRuleFact[], cancellation: DateRuleCancellation): RuleSelector {
  if (cancellation.selector) return cancellation.selector;
  const selectors = rules.filter((fact) => cancellation.targetOperationIds.includes(fact.operationId)).map((fact) => fact.rule.selector);
  if (!selectors.length || new Set(selectors.map((selector) => selector.scope)).size !== 1) throw new Error('解除する元指定の適用期間を確認してください。');
  const first = selectors[0];
  if (first.scope === 'once') return first;
  if (first.scope === 'ongoing') return { scope: 'ongoing', from: selectors.map((selector) => (selector as typeof first).from).sort()[0] };
  const ranges = selectors.map((selector) => (selector as typeof first).range);
  return { scope: 'period', range: { from: ranges.map((range) => range.from).sort()[0],
    through: ranges.some((range) => range.through === null) ? null : ranges.map((range) => range.through!).sort().at(-1)! } };
}

/** Preview a removal from authenticated sources. The fallback is a deadline reference, not a new manual date. */
export function v2CancellationProposal(rules: readonly ManualRuleFact[], frame: SharedOccurrence, subject: string | null, timeZone: string, cancellation: DateRuleCancellation) {
  const selected = selectManualRule(rules, frame, subject, timeZone);
  const currentIds = selected.kind === 'selected' ? selected.equivalentOperationIds : selected.kind === 'conflict' ? selected.candidates.map((fact) => fact.operationId) : [];
  if (canonicalJson([...currentIds].sort()) !== canonicalJson([...cancellation.targetOperationIds].sort())) throw new Error('解除する元の指定が変更されています。現在の内容を確認して申請してください。');
  const targets = rules.filter((fact) => cancellation.targetOperationIds.includes(fact.operationId));
  if (cancellation.selector && targets.some((fact) => !cancellationScopeMatches(fact.rule, cancellation.selector!, frame))) throw new Error('解除範囲の開始回を確認してください。');
  const remaining = selectManualRule(rules.filter((fact) => !cancellation.targetOperationIds.includes(fact.operationId)), frame, subject, timeZone);
  let target: DateTarget = { precision: 'date', date: frame.anchorDate }; let mode: DesignationMode = 'day';
  let options: DesignationOptions = { strict: false, adminLocked: false, forbidEarlier: false }; let targetTimeZone = timeZone;
  if (remaining.kind === 'conflict') throw new Error('解除後に残る日時指定が競合しています。先に内容を確認してください。');
  if (remaining.kind === 'selected') {
    const materialized = materializeRuleTarget(remaining.fact.rule, frame, timeZone);
    if (materialized.kind !== 'target') throw new Error('解除後に残る日時指定を確定できません。地域と周期を確認してください。');
    target = materialized.target; const rule = remaining.fact.rule; mode = rule.mode; targetTimeZone = rule.timeZoneAtCreation;
    options = { strict: rule.strict, adminLocked: rule.adminLocked, forbidEarlier: rule.forbidEarlier,
      ...(rule.allowDuringCooldown === undefined ? {} : { allowDuringCooldown: rule.allowDuringCooldown }) };
  }
  return { target, mode, options, automatic: remaining.kind === 'automatic', referenceAt: targetReferenceTime(target, targetTimeZone), timeZone: targetTimeZone };
}
