import type { ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import type { NextChoreWidgetSnapshot } from '@/features/widgets/contracts';

export function createTodayWidgetSnapshot(
  entries: readonly Pick<ChoreScheduleEntry, 'choreId' | 'suggestedDate' | 'status'>[],
  chores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
  today: LocalDate,
  updatedAt: string,
): NextChoreWidgetSnapshot {
  const todayEntries = entries
    .filter((entry) => entry.status === 'overdue' || entry.suggestedDate === today)
    .sort((left, right) => urgency(left.status) - urgency(right.status)
      || left.suggestedDate.localeCompare(right.suggestedDate));
  const names = todayEntries
    .map((entry) => chores.find((chore) => chore.id === entry.choreId)?.name)
    .filter((name): name is string => Boolean(name));
  return {
    todayChoreNames: names.slice(0, 3),
    remainingCount: Math.max(0, names.length - 3),
    updatedAt: updatedAt as NextChoreWidgetSnapshot['updatedAt'],
  };
}

function urgency(status: string): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}
