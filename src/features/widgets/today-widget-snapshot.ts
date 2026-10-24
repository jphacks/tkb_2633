import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import type { LocalDate } from '@/domain/shared/types';
import { addDays } from '@/domain/scheduling/local-date';
import { completionIncludesDate, completionMatchesEntry } from '@/domain/scheduling/completion-matching';
import type { NextChoreWidgetSnapshot, TodayWidgetChore } from '@/features/widgets/contracts';

export function createTodayWidgetSnapshot(
  entries: readonly ChoreScheduleEntry[],
  chores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
  completions: readonly ChoreCompletion[],
  today: LocalDate,
  updatedAt: string,
): NextChoreWidgetSnapshot {
  const activeEntries = entries.filter((entry) => entry.windowStart <= today
    && today <= addDays(entry.windowEnd, 1));
  const pendingEntries = activeEntries
    .filter((entry) => !completions.some((completion) => completionMatchesEntry(completion, entry)))
    .sort((left, right) => urgency(left.status) - urgency(right.status)
      || left.suggestedDate.localeCompare(right.suggestedDate));
  const completedEntries = activeEntries
    .filter((entry) => completions.some((completion) => completionMatchesEntry(completion, entry)))
    .sort((left, right) => left.suggestedDate.localeCompare(right.suggestedDate));

  const unresolvedRows: (TodayWidgetChore | null)[] = [
    ...pendingEntries.map((entry) => widgetRow(entry.id, entry.choreId, false, chores)),
    ...completedEntries.map((entry) => widgetRow(entry.id, entry.choreId, true, chores)),
    ...completions
      .filter((completion) => completion.outcome === 'completed'
        && completionIncludesDate(completion, today)
        && !activeEntries.some((entry) => completionMatchesEntry(completion, entry)))
      .map((completion) => widgetRow(`completed:${completion.id}`, completion.choreId, true, chores)),
  ];
  const rows = unresolvedRows.filter((row): row is TodayWidgetChore => row !== null);

  return {
    chores: rows.slice(0, 3),
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
