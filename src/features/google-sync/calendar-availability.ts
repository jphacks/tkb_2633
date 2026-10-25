import type { LocalDate } from '@/domain/shared/types';
import type { ExternalAvailabilityByDate } from '@/domain/scheduling/contracts';
import { addDays } from '@/domain/scheduling/local-date';
import { parseGoogleCompletedAt } from './google-completion-policy';
import { busyMinutesToBucket } from '@/domain/scheduling/calendar-penalty';

/** Only changes that alter the Scheduler penalty require a new plan; freshness metadata is excluded. */
export function calendarAvailabilitySignature(availability: ExternalAvailabilityByDate | undefined): string {
  return JSON.stringify(Object.entries(availability ?? {})
    .map(([date, day]) => [date, busyMinutesToBucket(day?.busyMinutes)] as const)
    .filter(([, bucket]) => bucket > 0)
    .sort(([left], [right]) => left.localeCompare(right)));
}

export const GOOGLE_CALENDAR_FREEBUSY_SCOPE = 'https://www.googleapis.com/auth/calendar.freebusy';
export const CALENDAR_AVAILABILITY_MAX_AGE_MS = 36 * 60 * 60 * 1000;
export const CALENDAR_REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const CALENDAR_RETRY_INTERVAL_MS = 60 * 60 * 1000;
export type CalendarAvailabilityStatus = 'idle' | 'syncing' | 'retryPending' | 'permissionRequired' | 'error';

export interface CalendarAvailabilityState {
  householdId: string;
  enabled: boolean;
  status: CalendarAvailabilityStatus;
  retryCount: number;
  lastAttemptAt?: string;
  lastSuccessfulSyncAt?: string;
  nextRetryAt?: string;
  lastErrorCode?: string;
  updatedAt: string;
}

export interface CalendarAvailabilityDay {
  localDate: LocalDate;
  busyMinutes: number;
  timeZone: string;
  fetchedAt: string;
}

export interface CalendarQueryRange {
  from: LocalDate;
  through: LocalDate;
  timeMin: string;
  timeMax: string;
  timeZone: string;
}

export class CalendarPermissionRequiredError extends Error {
  constructor() {
    super('Calendar availability permission is required');
    this.name = 'CalendarPermissionRequiredError';
  }
}

export function getDeviceTimeZone(): string {
  try {
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    new Intl.DateTimeFormat('en', { timeZone }).format();
    return timeZone || 'UTC';
  } catch { return 'UTC'; }
}

function dateFormatter(timeZone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
}

function formattedDate(formatter: Intl.DateTimeFormat, instant: number): LocalDate {
  const parts = formatter.formatToParts(instant);
  const part = (type: string) => parts.find((value) => value.type === type)!.value;
  return `${part('year')}-${part('month')}-${part('day')}` as LocalDate;
}

/** First instant of a local day; date comparisons also handle 23/25-hour DST days. */
function dayStart(date: LocalDate, formatter: Intl.DateTimeFormat): number {
  const utc = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(utc) || new Date(utc).toISOString().slice(0, 10) !== date) throw new RangeError('Invalid local date');
  let low = utc - 36 * 60 * 60 * 1000;
  let high = utc + 36 * 60 * 60 * 1000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (formattedDate(formatter, mid) < date) low = mid + 1;
    else high = mid;
  }
  return low;
}

export function createCalendarQueryRange(from: LocalDate, through: LocalDate, timeZone: string): CalendarQueryRange {
  if (from > through) throw new RangeError('Invalid calendar query coverage');
  const formatter = dateFormatter(timeZone);
  return { from, through, timeZone,
    timeMin: new Date(dayStart(from, formatter)).toISOString(),
    timeMax: new Date(dayStart(addDays(through, 1), formatter)).toISOString() };
}

/** Raw intervals only exist in memory. Invalid data fails the refresh instead of inventing free time. */
export function aggregateBusyMinutes(
  busy: readonly { start: string; end: string }[], range: CalendarQueryRange, fetchedAt: string,
): CalendarAvailabilityDay[] {
  const min = Date.parse(range.timeMin);
  const max = Date.parse(range.timeMax);
  const intervals = busy.map((item) => {
    const start = parseGoogleCompletedAt(item.start);
    const end = parseGoogleCompletedAt(item.end);
    if (!start || !end || Date.parse(end) <= Date.parse(start)) throw new Error('Invalid calendar busy interval');
    return { start: Math.max(min, Date.parse(start)), end: Math.min(max, Date.parse(end)) };
  }).filter((item) => item.start < item.end).sort((a, b) => a.start - b.start);
  const merged: { start: number; end: number }[] = [];
  for (const item of intervals) {
    const previous = merged.at(-1);
    if (previous && item.start <= previous.end) previous.end = Math.max(previous.end, item.end);
    else merged.push({ ...item });
  }
  const formatter = dateFormatter(range.timeZone);
  const days: CalendarAvailabilityDay[] = [];
  let start = min;
  for (let date = range.from; date <= range.through; date = addDays(date, 1)) {
    const end = dayStart(addDays(date, 1), formatter);
    const milliseconds = merged.reduce((sum, interval) =>
      sum + Math.max(0, Math.min(end, interval.end) - Math.max(start, interval.start)), 0);
    days.push({ localDate: date, busyMinutes: Math.ceil(milliseconds / 60_000), timeZone: range.timeZone, fetchedAt });
    start = end;
  }
  return days;
}

export function freshCalendarAvailability(
  state: CalendarAvailabilityState | null, days: readonly CalendarAvailabilityDay[], now: Date, timeZone: string,
): ExternalAvailabilityByDate | undefined {
  if (!state?.enabled) return undefined;
  const entries = days.filter((day) => {
    const fetched = Date.parse(day.fetchedAt);
    return day.timeZone === timeZone && Number.isFinite(fetched)
      && fetched <= now.getTime() && now.getTime() - fetched <= CALENDAR_AVAILABILITY_MAX_AGE_MS
      && Number.isInteger(day.busyMinutes) && day.busyMinutes >= 0;
  }).map((day) => [day.localDate, { busyMinutes: day.busyMinutes }] as const);
  return entries.length ? Object.fromEntries(entries) : undefined;
}

export function shouldRefreshCalendar(state: CalendarAvailabilityState | null, now: Date, force = false): boolean {
  if (!state?.enabled) return false;
  if (force) return true;
  if (state.status === 'permissionRequired' || state.status === 'error') return false;
  if (state.status === 'syncing') {
    return !state.lastAttemptAt || Date.parse(state.lastAttemptAt) + 10 * 60 * 1000 <= now.getTime();
  }
  if (state.status === 'retryPending') return Boolean(state.nextRetryAt && Date.parse(state.nextRetryAt) <= now.getTime());
  return !state.lastSuccessfulSyncAt || Date.parse(state.lastSuccessfulSyncAt) + CALENDAR_REFRESH_INTERVAL_MS <= now.getTime();
}
