import { compareTaskKeys, taskPriority } from '../../../domain/scheduling/task-priority.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { ChoreLoad } from '../../../domain/chores/types';

export function orderTaskRows<T extends { key: string; source: 'waste' | 'personal' | 'shared' }>(
  rows: readonly T[], today: LocalDate,
  describe: (row: T) => { completed: boolean; load: ChoreLoad; recommendedDate: LocalDate; windowEnd?: LocalDate; asOfDate?: LocalDate },
): T[] {
  const ranked = rows.map(row => {
    if (row.source === 'waste') return { row, rank: -1 };
    const value = describe(row); return { row, rank: taskPriority(value, value.asOfDate ?? today) };
  });
  return ranked.sort((a, b) => a.rank - b.rank || compareTaskKeys(a.row.key, b.row.key)).map(entry => entry.row);
}
