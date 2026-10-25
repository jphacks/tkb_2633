import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { calendarPendingCountsByDate } from '../calendar/day-entries.ts';
import { completionCycleDate, completionIncludesDate, completionMatchesEntry } from './completion-matching.ts';
import { addDays, daysBetween, localDateFromISODateTime } from './local-date.ts';

export interface DateTask {
  id: string;
  choreId: string;
  suggestedDate: LocalDate;
  completed: boolean;
  entry?: ChoreScheduleEntry;
  completion?: ChoreCompletion;
}

/** A recurring chore appears once per day, while its individual occurrences remain available in history. */
export function selectDateTasks(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[],
  date: LocalDate,
  graceDays = 0,
): DateTask[] {
  const relevantCompletions = completions.filter((completion) => completionIncludesDate(completion, date));
  const byChore = new Map<string, DateTask>();

  for (const entry of entries) {
    if (entry.windowStart > date || date > addDays(entry.windowEnd, graceDays)) continue;
    const completion = completions.find((candidate) => completionMatchesEntry(candidate, entry));
    const task: DateTask = {
      id: entry.id, choreId: entry.choreId, suggestedDate: entry.suggestedDate,
      completed: Boolean(completion), entry, completion,
    };
    const previous = byChore.get(entry.choreId);
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(entry.choreId, task);
  }

  for (const completion of relevantCompletions) {
    const previous = byChore.get(completion.choreId);
    if (previous?.completion?.id === completion.id) continue;
    const task: DateTask = {
      id: `completed:${completion.id}`, choreId: completion.choreId,
      suggestedDate: completion.scheduledDate ?? localDateFromISODateTime(completion.completedAt),
      completed: true, completion,
    };
    // Today's real completion must remain visible even if recalculation created another overlapping cycle.
    if (!previous || compareOccurrence(task, previous, date) < 0) byChore.set(completion.choreId, task);
  }
  return [...byChore.values()];
}

function compareOccurrence(left: DateTask, right: DateTask, date: LocalDate): number {
  const completedOnDate = (task: DateTask) => Boolean(task.completion
    && completionCycleDate(task.completion) === date);
  const inWindow = (task: DateTask) => task.entry
    ? task.entry.windowStart <= date && date <= task.entry.windowEnd
    : Boolean(task.completion && completionIncludesDate(task.completion, date));
  return Number(completedOnDate(right)) - Number(completedOnDate(left))
    || Number(right.suggestedDate === date) - Number(left.suggestedDate === date)
    || Number(inWindow(right)) - Number(inWindow(left))
    || Math.abs(daysBetween(date, left.suggestedDate)) - Math.abs(daysBetween(date, right.suggestedDate))
    || right.suggestedDate.localeCompare(left.suggestedDate)
    || Number(right.completed) - Number(left.completed)
    || left.id.localeCompare(right.id);
}

export function orderDateTasks(
  tasks: readonly DateTask[],
  date: LocalDate,
  chores: readonly Pick<ChoreDefinition, 'id' | 'load'>[],
): DateTask[] {
  const loadById = new Map(chores.map((chore) => [chore.id, chore.load]));
  const priority = (task: DateTask) => loadById.get(task.choreId) === 'heavy' ? 0
    : loadById.get(task.choreId) === 'normal' ? 1 : 2;
  return [...tasks].sort((left, right) => Number(left.suggestedDate !== date) - Number(right.suggestedDate !== date)
    || priority(left) - priority(right)
    || Number(left.completed) - Number(right.completed));
}

export function recommendedChoreCounts(
  entries: readonly ChoreScheduleEntry[],
  completions: readonly ChoreCompletion[] = [],
): Map<LocalDate, number> {
  return calendarPendingCountsByDate(entries, completions);
}
