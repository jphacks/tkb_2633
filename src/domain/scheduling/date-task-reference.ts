import type { DateTask } from './date-tasks';
import type { LocalDate } from '../shared/types';

/** A displayed selection, rather than an entry supplied by another workspace. */
export interface PersonalDateTaskCommand {
  date: LocalDate;
  graceDays: 0 | 3;
  choreId: string;
  revision: string;
  completed: boolean;
}

/** Changing the selected occurrence or completion invalidates an old checkbox. */
export function dateTaskRevision(task: DateTask): string {
  return JSON.stringify([task.id, task.choreId, task.suggestedDate, task.completed,
    task.entry?.householdId, task.entry?.cycleBaseDate, task.entry?.windowStart, task.entry?.windowEnd,
    task.completion?.id, task.completion?.completedAt, task.completion?.completedLocalDate,
    task.completion?.scheduleEntryId, task.completion?.scheduledDate,
    task.completion?.scheduledWindowStart, task.completion?.scheduledWindowEnd]);
}
