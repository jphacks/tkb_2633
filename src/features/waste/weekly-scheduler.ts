import type { LocalDate, Weekday } from '@/domain/shared/types';
import type { WasteCollectionOccurrence, WeeklyWasteSchedule } from '@/features/waste/contracts';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function generateWeeklyCollectionDates(
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
  const occurrences: WasteCollectionOccurrence[] = [];

  for (let timestamp = start.getTime(); timestamp <= end.getTime(); timestamp += DAY_IN_MILLISECONDS) {
    const date = new Date(timestamp);
    const weekday = (date.getUTCDay() || 7) as Weekday;

    if (weekdays.has(weekday)) {
      occurrences.push({
        scheduleId: schedule.id,
        householdId: schedule.householdId,
        label: schedule.label,
        date: date.toISOString().slice(0, 10) as LocalDate,
      });
    }
  }

  return occurrences;
}

function parseLocalDate(value: LocalDate): Date {
  const parts = value.split('-').map(Number);
  if (parts.length !== 3 || parts.some((part) => !Number.isInteger(part))) {
    throw new RangeError(`Invalid local date: ${value}`);
  }

  const [year, month, day] = parts;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.toISOString().slice(0, 10) !== value) {
    throw new RangeError(`Invalid local date: ${value}`);
  }
  return date;
}
