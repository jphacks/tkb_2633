import type { ChoreLoad } from '../chores/types';
import type { LocalDate } from '../shared/types';
import { daysBetween } from './local-date.ts';

export interface TaskPriority {
  completed: boolean;
  load: ChoreLoad;
  recommendedDate: LocalDate;
  windowEnd?: LocalDate;
}

export const compareTaskKeys = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;

/** Presentation only. The shared Scheduler's dates and occurrence identities stay unchanged. */
export function isTaskUrgent(task: TaskPriority, today: LocalDate): boolean {
  return !task.completed && task.recommendedDate < today && task.windowEnd !== undefined
    && daysBetween(today, task.windowEnd) <= 2;
}

export function taskPriority(task: TaskPriority, today: LocalDate): number {
  const tier = task.completed ? 2 : isTaskUrgent(task, today) ? 0 : 1;
  return tier * 3 + (task.load === 'heavy' ? 0 : task.load === 'normal' ? 1 : 2);
}
