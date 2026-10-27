import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { canonicalJson } from '../operations.ts';
import { uniqueCausalFacts, maximalCausalFacts } from './causal-facts.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { CivilRange, ManualRuleFact, SharedOccurrence } from './model.ts';

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
export function selectManualRule(facts: readonly ManualRuleFact[], occurrence: SharedOccurrence, subjectUserId: string | null):
  { kind: 'automatic' } | { kind: 'selected'; fact: ManualRuleFact; equivalentOperationIds: string[] } | { kind: 'conflict'; candidates: ManualRuleFact[] } {
  const matching = uniqueCausalFacts(facts).filter(({ rule }) => {
    if (rule.choreId !== occurrence.choreId || rule.subjectUserId !== subjectUserId) return false;
    if (rule.selector.scope === 'once') return rule.selector.occurrenceId === occurrence.id;
    const from = rule.selector.scope === 'period' ? rule.selector.range.from : rule.selector.from;
    const through = rule.selector.scope === 'period' ? rule.selector.range.through : null;
    return from <= occurrence.anchorDate && (through === null || occurrence.anchorDate <= through);
  });
  if (!matching.length) return { kind: 'automatic' };
  const rank = (fact: ManualRuleFact) => fact.rule.selector.scope === 'once' ? 3 : fact.rule.selector.scope === 'period' ? 2 : 1;
  const maximum = Math.max(...matching.map(rank)); const priority = matching.filter((fact) => rank(fact) === maximum);
  const candidates = maximalCausalFacts(priority);
  const content = (fact: ManualRuleFact) => canonicalJson({ mode: fact.rule.mode, target: fact.rule.target,
    strict: fact.rule.strict, adminLocked: fact.rule.adminLocked, forbidEarlier: fact.rule.forbidEarlier });
  if (new Set(candidates.map(content)).size > 1) return { kind: 'conflict', candidates };
  return { kind: 'selected', fact: candidates[0], equivalentOperationIds: candidates.map((item) => item.operationId) };
}
