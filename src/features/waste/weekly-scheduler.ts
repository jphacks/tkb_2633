import { daysBetween, parseLocalDate, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { LocalDate } from '@/domain/shared/types';
import type { WasteCollectionOccurrence, WeeklyWasteSchedule } from '@/features/waste/contracts';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function generateWasteCollectionDates(
  schedule: WeeklyWasteSchedule,
  from: LocalDate,
  through: LocalDate,
): WasteCollectionOccurrence[] {
  const start = parseLocalDate(from);
  const end = parseLocalDate(through);

  if (start.getTime() > end.getTime()) {
    throw new RangeError('from must be on or before through');
  }

  const weekdays = new Set(schedule.collectionWeekdays);
  const recurrence = schedule.recurrence ?? 'weekly';
  if (schedule.anchorDate) parseLocalDate(schedule.anchorDate);
  const occurrences: WasteCollectionOccurrence[] = [];

  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += DAY_IN_MILLISECONDS) {
    const date = new Date(timestamp);
    const localDate = date.toISOString().slice(0, 10) as LocalDate;
    const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    const matches = recurrence === 'weekly'
      ? weekdays.has(weekdayOf(localDate))
      : recurrence === 'biweekly'
        ? Boolean(schedule.anchorDate && localDate >= schedule.anchorDate && daysBetween(schedule.anchorDate, localDate) % 14 === 0)
        : recurrence === 'monthly' && Number.isInteger(schedule.monthlyDay) && schedule.monthlyDay! >= 1 && schedule.monthlyDay! <= 31
          && (!schedule.anchorDate || localDate >= schedule.anchorDate)
          && date.getUTCDate() === Math.min(schedule.monthlyDay!, lastDay);

    if (matches) {
      occurrences.push({
        scheduleId: schedule.id,
        householdId: schedule.householdId,
        label: schedule.label,
        date: localDate,
      });
    }
  }

  return occurrences;
}

/** Compatibility for older callers; all modes use the same calculation. */
export const generateWeeklyCollectionDates = generateWasteCollectionDates;
