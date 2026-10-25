import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import type { NextChoreWidgetSnapshot, TodayWidgetChore } from '@/features/widgets/contracts';

export function createTodayWidgetSnapshot(
  entries: readonly ChoreScheduleEntry[],
  chores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
  completions: readonly ChoreCompletion[],
  today: LocalDate,
  updatedAt: string,
): NextChoreWidgetSnapshot {
  const tasks = selectDateTasks(entries, completions, today, 1)
    .sort((left, right) => Number(left.completed) - Number(right.completed)
      || urgency(left.entry?.status ?? 'scheduled') - urgency(right.entry?.status ?? 'scheduled')
      || left.suggestedDate.localeCompare(right.suggestedDate));
  const unresolvedRows = tasks.map((task) => widgetRow(task.id, task.choreId, task.completed, chores));
  const rows = unresolvedRows.filter((row): row is TodayWidgetChore => row !== null);
  const visible = rows.slice(0, 3);
  const checkedRow = rows.find((row) => row.completed);
  // Keep a checkmark visible after completion even when three or more chores are still pending.
  if (checkedRow && visible.length === 3 && visible.every((row) => !row.completed)) visible[2] = checkedRow;

  return {
    chores: visible,
    remainingCount: Math.max(0, rows.length - 3),
    updatedAt: updatedAt as NextChoreWidgetSnapshot['updatedAt'],
  };
}

function widgetRow(
  id: string,
  choreId: string,
  completed: boolean,
  chores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
) {
  const chore = chores.find((item) => item.id === choreId);
  return chore ? { id, name: chore.name, completed } : null;
}

function urgency(status: ChoreScheduleEntry['status']): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}
