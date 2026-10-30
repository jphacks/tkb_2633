import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDateAtTime } from '../group-clock.ts';
import { uniqueCausalFacts } from './causal-facts.ts';
import { maximalManualRules } from './formal-rules.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { CivilRange, ManualRuleFact, SharedOccurrence, RuleSelector } from './model.ts';
import { normalizeDateTarget, targetReferenceTime } from './date-target.ts';
import { materializeRuleTarget } from './rule-target.ts';

function validateRange(range: CivilRange): void {
  parseLocalDate(range.from); if (range.through !== null) parseLocalDate(range.through);
  if (range.through !== null && range.from > range.through) throw new Error('適用期間の開始と終了を確認してください。');
}
/** Returns only the untouched parts of an old range. Facts themselves remain immutable. */
export function subtractCivilRange(previous: CivilRange, replacement: CivilRange): CivilRange[] {
  validateRange(previous); validateRange(replacement);
  if (previous.through !== null && previous.through < replacement.from || replacement.through !== null && replacement.through < previous.from) return [{ ...previous }];
  const result: CivilRange[] = [];
  if (previous.from < replacement.from) result.push({ from: previous.from, through: addDays(replacement.from, -1) });
  if (replacement.through !== null && replacement.through < '9999-12-31' && (previous.through === null || replacement.through < previous.through)) {
    result.push({ from: addDays(replacement.through, 1), through: previous.through });
  }
  return result;
}
export function finiteValidity(from: LocalDate, selection: 'twoWeeks' | 'oneMonth' | 'endDate', through?: LocalDate): CivilRange {
  parseLocalDate(from);
  if (selection === 'twoWeeks') return { from, through: addDays(from, 13) };
  if (selection === 'endDate') { if (!through) throw new Error('終了日を選んでください。'); const range = { from, through }; validateRange(range); return range; }
  if (selection !== 'oneMonth') throw new Error('適用期間を確認してください。');
  const start = new Date(`${from}T00:00:00Z`); const day = start.getUTCDate(); start.setUTCDate(1); start.setUTCMonth(start.getUTCMonth() + 1);
  const last = new Date(start); last.setUTCMonth(last.getUTCMonth() + 1); last.setUTCDate(0);
  start.setUTCDate(Math.min(day, last.getUTCDate()));
  const exclusive = start.toISOString().slice(0, 10) as LocalDate; parseLocalDate(exclusive);
  return { from, through: addDays(exclusive, -1) };
}
export function ruleSelectorMatches(selector: RuleSelector, occurrence: SharedOccurrence): boolean {
  if (selector.scope === 'once') return selector.occurrenceId === occurrence.id;
  const from = selector.scope === 'period' ? selector.range.from : selector.from;
  const through = selector.scope === 'period' ? selector.range.through : null;
  return from <= occurrence.anchorDate && (through === null || occurrence.anchorDate <= through);
}
export function manualRuleMatches(fact: ManualRuleFact, occurrence: SharedOccurrence): boolean {
  return ruleSelectorMatches(fact.rule.selector, occurrence)
    && !(fact.excludedSelectors ?? []).some((selector) => ruleSelectorMatches(selector, occurrence));
}
/** Subtract exclusions before expanding inverse date queries, retaining the immutable source range. */
export function uncancelledRuleRanges(fact: ManualRuleFact, range: CivilRange): CivilRange[] {
  let result = [range];
  for (const selector of fact.excludedSelectors ?? []) {
    const removed = selector.scope === 'once' ? { from: selector.anchorDate, through: selector.anchorDate }
      : selector.scope === 'period' ? selector.range : { from: selector.from, through: null };
    result = result.flatMap((part) => subtractCivilRange(part, removed));
  }
  return result;
}
export function selectManualRule(facts: readonly ManualRuleFact[], occurrence: SharedOccurrence, subjectUserId: string | null, timeZone?: string):
  { kind: 'automatic' } | { kind: 'selected'; fact: ManualRuleFact; equivalentOperationIds: string[] } | { kind: 'conflict'; candidates: ManualRuleFact[] } {
  const matching = uniqueCausalFacts(facts).filter((fact) => {
    const { rule } = fact;
    if (rule.choreId !== occurrence.choreId || rule.subjectUserId !== subjectUserId) return false;
    return manualRuleMatches(fact, occurrence);
  });
  if (!matching.length) return { kind: 'automatic' };
  const rank = (fact: ManualRuleFact) => fact.rule.selector.scope === 'once' ? 3 : fact.rule.selector.scope === 'period' ? 2 : 1;
  const maximum = Math.max(...matching.map(rank)); const priority = matching.filter((fact) => rank(fact) === maximum);
  const candidates = maximalManualRules(priority);
  const content = (fact: ManualRuleFact) => {
    const raw = normalizeDateTarget(fact.rule.target);
    const target = timeZone ? materializeRuleTarget(fact.rule, occurrence, timeZone)
      : fact.rule.selector.scope === 'once' ? raw : raw.precision === 'date'
        ? { ...raw, date: addDays(raw.date, daysBetween(fact.rule.referenceAnchorDate, occurrence.anchorDate)) }
        : (() => { throw new Error('A shared timezone is required to compare repeating clock times'); })();
    const reviewSource = 'kind' in target && target.kind === 'review' ? { target: raw, referenceAnchorDate: fact.rule.referenceAnchorDate,
      timeZoneAtCreation: fact.rule.timeZoneAtCreation, ruleVersion: fact.rule.ruleVersion } : null;
    const materialized = 'kind' in target ? target.kind === 'target' ? target.target : null : target;
    const dateReference = materialized?.precision === 'date' ? targetReferenceTime(materialized, fact.rule.timeZoneAtCreation) : null;
    const dayStartsAt = fact.rule.mode === 'day' && materialized?.precision === 'date'
      ? sharedDateAtTime(materialized.date, 0, 0, fact.rule.timeZoneAtCreation).getTime() : null;
    return canonicalJson({ mode: fact.rule.mode, target, dateReference, dayStartsAt, reviewSource,
    strict: fact.rule.strict, adminLocked: fact.rule.adminLocked, forbidEarlier: fact.rule.forbidEarlier,
    allowDuringCooldown: fact.rule.allowDuringCooldown === true });
  };
  if (new Set(candidates.map(content)).size > 1) return { kind: 'conflict', candidates };
  return { kind: 'selected', fact: candidates[0], equivalentOperationIds: candidates.map((item) => item.operationId) };
}
