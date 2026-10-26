import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';

/**
 * A dependency belongs to the latest predecessor cycle due by the successor's
 * cycle, even if either suggested day moves. A later, unrelated cycle must not
 * postpone all the intervening occurrences of a more frequent successor.
 */
export function dependencyPredecessorForDate(
  entries: readonly ChoreScheduleEntry[],
  successorCycleDate: LocalDate,
): ChoreScheduleEntry | undefined {
  let latest: ChoreScheduleEntry | undefined;
  let firstInitial: ChoreScheduleEntry | undefined;
  for (const entry of entries) {
    if (entry.cycleBaseDate <= successorCycleDate
      && (!latest || entry.cycleBaseDate > latest.cycleBaseDate)) latest = entry;
    if ((entry.status === 'initialPending' || entry.id.endsWith(':initial'))
      && (!firstInitial || entry.cycleBaseDate < firstInitial.cycleBaseDate)) firstInitial = entry;
  }
  // With no past anchor, the first successor must wait for the first predecessor.
  // Known recurring chores already have a past completion/estimated anchor.
  return latest ?? firstInitial;
}
