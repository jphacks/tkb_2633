import { compareTaskKeys, compareTaskMinutes, taskPriority } from './task-priority.ts';
import type { TaskPriority, LoadOrder } from './task-priority';
import type { LocalDate } from '../shared/types';

/** Shared presentation order; source identity never overrides urgency, load or completion. */
export function orderTaskRows<T extends { key: string; source: 'waste' | 'personal' | 'shared' }>(
  rows: readonly T[], today: LocalDate,
  describe: (row: T) => TaskPriority & { asOfDate?: LocalDate; estimatedMinutes?: number },
  order?: LoadOrder,
): T[] {
  const ranked = rows.map(row => {
    if (row.source === 'waste') return { row, rank: -1, minutes: undefined };
    const value = describe(row); return { row, rank: taskPriority(value, value.asOfDate ?? today, order), minutes: value.estimatedMinutes };
  });
  return ranked.sort((a, b) => a.rank - b.rank || (order ? compareTaskMinutes(a.minutes, b.minutes, order) : 0) || compareTaskKeys(a.row.key, b.row.key)).map(entry => entry.row);
}
