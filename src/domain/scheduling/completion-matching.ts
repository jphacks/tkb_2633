import type { ChoreCompletion, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { localDateFromISODateTime } from './local-date.ts';

type CompletionTiming = Pick<ChoreCompletion, 'completedAt' | 'scheduledDate' | 'scheduledWindowStart'>;

export function completionWasRecordedBeforeWindow(completion: CompletionTiming): boolean {
  const windowStart = completion.scheduledWindowStart ?? completion.scheduledDate;
  return Boolean(windowStart && localDateFromISODateTime(completion.completedAt) < windowStart);
}

/** Future occurrences advance their cycle on the scheduled day, while keeping the actual recording time. */
export function completionCycleDate(completion: CompletionTiming): LocalDate {
  return completionWasRecordedBeforeWindow(completion)
    ? (completion.scheduledDate ?? completion.scheduledWindowStart)!
    : localDateFromISODateTime(completion.completedAt);
}

export function completionMatchesEntry(
  completion: ChoreCompletion,
  entry: ChoreScheduleEntry,
): boolean {
  if (completion.outcome !== 'completed' || completion.choreId !== entry.choreId) return false;
  if (completion.scheduleEntryId) return completion.scheduleEntryId === entry.id;

  if (completion.scheduledDate) {
    return completion.scheduledDate === entry.suggestedDate
      && (!completion.scheduledWindowStart || completion.scheduledWindowStart === entry.windowStart)
      && (!completion.scheduledWindowEnd || completion.scheduledWindowEnd === entry.windowEnd);
  }

  const completedDate = localDateFromISODateTime(completion.completedAt);
  return completedDate >= entry.windowStart && completedDate <= entry.windowEnd;
}

export function completionPeriod(completion: ChoreCompletion): { start: LocalDate; end: LocalDate } {
  const fallback = completion.scheduledDate ?? localDateFromISODateTime(completion.completedAt);
  return {
    start: completion.scheduledWindowStart ?? fallback,
    end: completion.scheduledWindowEnd ?? fallback,
  };
}

export function completionIncludesDate(completion: ChoreCompletion, date: LocalDate): boolean {
  if (completion.outcome !== 'completed') return false;
  const period = completionPeriod(completion);
  return (date >= period.start && date <= period.end)
    || (!completionWasRecordedBeforeWindow(completion) && localDateFromISODateTime(completion.completedAt) === date);
}
