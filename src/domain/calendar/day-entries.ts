import type { ChoreCompletion, ChoreScheduleEntry } from '@/domain/chores/types';
import { completionMatchesEntry } from '../scheduling/completion-matching.ts';
import type { LocalDate } from '@/domain/shared/types';

export function calendarEntriesOnDate(entries: readonly ChoreScheduleEntry[], date: LocalDate): ChoreScheduleEntry[] {
  return entries.filter((entry) => entry.windowStart <= date && date <= entry.windowEnd);
}

export function calendarPendingCountsByDate(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[],
): Map<LocalDate, number> {
  const choresByDate = new Map<LocalDate, Set<string>>();
  const completedEntryIds = new Set(completions
    .filter((completion) => completion.outcome === 'completed' && completion.scheduleEntryId)
    .map((completion) => completion.scheduleEntryId));
  const legacyCompletions = completions.filter((completion) => !completion.scheduleEntryId);
  for (const entry of entries) {
    if (completedEntryIds.has(entry.id)
      || legacyCompletions.some((completion) => completionMatchesEntry(completion, entry))) continue;
    const chores = choresByDate.get(entry.suggestedDate) ?? new Set<string>();
    chores.add(entry.choreId);
    choresByDate.set(entry.suggestedDate, chores);
  }
  return new Map([...choresByDate].map(([date, chores]) => [date, chores.size]));
}
