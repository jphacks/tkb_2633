import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';

export function calendarEntriesOnDate(entries: readonly ChoreScheduleEntry[], date: LocalDate): ChoreScheduleEntry[] {
  return entries.filter((entry) => entry.windowStart <= date && date <= entry.windowEnd);
}
