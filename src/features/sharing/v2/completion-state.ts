import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { causallyPrecedes } from '../operations.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { uniqueCausalFacts } from './causal-facts.ts';
import { fixedInterval, instantMilliseconds, targetCivilDate, targetReferenceTime, validateDesignationTarget } from './date-target.ts';
import type { CausalStamp, CompletionFact, DateTarget, DesignationMode, SharedChorePolicy } from './model.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

export type CausalCompletionFact = CompletionFact & CausalStamp;
export interface CompletionUndo extends CausalStamp { targetOperationId: string; authorUserId: string }

/** Undo authorization is resolved from verified historical membership, not a payload role flag. */
export function deriveOccurrenceCompletion(input: { occurrenceId: string; policy: SharedChorePolicy;
  subjectUserIds: readonly string[]; facts: readonly CausalCompletionFact[]; undos: readonly CompletionUndo[];
  authorizeUndo: (undo: CompletionUndo, target: CausalCompletionFact) => boolean }) {
  const history = uniqueCausalFacts(input.facts).filter((fact) => fact.occurrenceId === input.occurrenceId);
  const byId = new Map(history.map((fact) => [fact.operationId, fact])); const undone = new Set<string>();
  for (const undo of uniqueCausalFacts(input.undos)) {
    const target = byId.get(undo.targetOperationId);
    if (!target) continue;
    if (!causallyPrecedes(target, undo) || !input.authorizeUndo(undo, target)) throw new Error('完了を取り消す権限または対象を確認してください。');
    undone.add(target.operationId);
  }
  const active = history.filter((fact) => !undone.has(fact.operationId) && fact.acceptance === 'accepted');
  const completedBySubject = Object.fromEntries([...new Set(input.subjectUserIds)].sort().map((id) => [id,
    active.some((fact) => fact.subjectUserId === id)]));
  const completed = input.policy.completion === 'one' ? active.some((fact) => fact.subjectUserId === null)
    : Object.keys(completedBySubject).length > 0 && Object.values(completedBySubject).every(Boolean);
  return { completed, completedBySubject, active, history };
}
/** Pass the active facts from deriveOccurrenceCompletion, excluding targeted cancellations. */
export function minimumNextExecutionDay(cycleDays: number, activeFacts: readonly CompletionFact[], timeZone: string, subjectUserId: string | null): LocalDate | null {
  if (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 3650) throw new Error('周期を確認してください。');
  if (cycleDays === 1 || cycleDays >= 7) return null;
  const days = activeFacts.filter((fact) => fact.acceptance === 'accepted' && fact.subjectUserId === subjectUserId)
    .map((fact) => sharedLocalDate(new Date(instantMilliseconds(fact.performedAt)), timeZone)).sort();
  return days.length ? addDays(days.at(-1)!, cycleDays) : null;
}
export function fulfillmentAt(performedAt: string, designation: { mode: DesignationMode; target: DateTarget }, timeZone: string): 'fulfilled' | 'earlier' | 'later' {
  const instant = instantMilliseconds(performedAt);
  const target = validateDesignationTarget(designation.mode, designation.target);
  if (designation.mode === 'deadline') return instant <= targetReferenceTime(target, timeZone) ? 'fulfilled' : 'later';
  if (designation.mode === 'day') {
    const actual = sharedLocalDate(new Date(instant), timeZone); const expected = targetCivilDate(target, timeZone);
    return actual === expected ? 'fulfilled' : actual < expected ? 'earlier' : 'later';
  }
  const interval = fixedInterval(target);
  if (!interval) throw new Error('固定日時の時間帯を確認してください。');
  // performedAt records finishing the work; finishing exactly at the end satisfies the instruction.
  return instant < interval.start ? 'earlier' : instant > interval.end ? 'later' : 'fulfilled';
}
export function showExpiredOnHome(windowEnd: LocalDate, today: LocalDate): boolean {
  const age = daysBetween(windowEnd, today);
  return age >= 1 && age <= 5;
}
