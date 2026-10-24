import type { LocalDate, Weekday } from '@/domain/shared/types';

const DAY_IN_MILLISECONDS = 24 * 60 * 60 * 1000;

export function localDateFromDate(date: Date): LocalDate {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}` as LocalDate;
}

export function localDateFromISODateTime(value: string): LocalDate {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new RangeError(`Invalid ISO date-time: ${value}`);
  return localDateFromDate(date);
}

export function millisecondsUntilNextLocalDay(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function parseLocalDate(value: LocalDate): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new RangeError(`Invalid local date: ${value}`);
  const [, yearText, monthText, dayText] = match;
  const date = new Date(Date.UTC(Number(yearText), Number(monthText) - 1, Number(dayText)));
  if (date.toISOString().slice(0, 10) !== value) throw new RangeError(`Invalid local date: ${value}`);
  return date;
}

export function addDays(value: LocalDate, amount: number): LocalDate {
  if (!Number.isInteger(amount)) throw new RangeError('amount must be an integer');
  const date = parseLocalDate(value);
  date.setUTCDate(date.getUTCDate() + amount);
  return date.toISOString().slice(0, 10) as LocalDate;
}

export function daysBetween(from: LocalDate, through: LocalDate): number {
  return (parseLocalDate(through).getTime() - parseLocalDate(from).getTime()) / DAY_IN_MILLISECONDS;
}

export function weekdayOf(value: LocalDate): Weekday {
  const day = parseLocalDate(value).getUTCDay();
  return (day === 0 ? 7 : day) as Weekday;
}

export function formatJapaneseDate(value: LocalDate, options: { year?: boolean; weekday?: boolean } = {}): string {
  const date = parseLocalDate(value);
  const month = date.getUTCMonth() + 1;
  const day = date.getUTCDate();
  const weekday = ['日', '月', '火', '水', '木', '金', '土'][date.getUTCDay()];
  const year = options.year ? `${date.getUTCFullYear()}年` : '';
  return `${year}${month}月${day}日${options.weekday ? `（${weekday}）` : ''}`;
}

export function monthKey(value: LocalDate): string {
  return value.slice(0, 7);
}

export function monthDates(year: number, monthIndex: number): LocalDate[] {
  const days = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: days }, (_, index) =>
    `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(index + 1).padStart(2, '0')}` as LocalDate,
  );
}
