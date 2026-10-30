import moment from 'moment-timezone';
import type { LocalDate } from '../../domain/shared/types.ts';

// A common tzdb avoids different DST rules on older Android and newer iOS releases.
export const SHARED_TIME_ZONE_DATA_VERSION = moment.tz.dataVersion;
export function isSharedTimeZone(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 100 && Boolean(moment.tz.zone(value));
}
function zoneFor(timeZone: string) {
  const zone = moment.tz.zone(timeZone); if (!zone) throw new Error('Unsupported shared timezone'); return zone;
}
export function sharedLocalDate(now: Date, timeZone: string): LocalDate {
  const instant = now.getTime(); if (!Number.isFinite(instant)) throw new Error('Invalid group clock');
  return new Date(instant - zoneFor(timeZone).utcOffset(instant) * 60_000).toISOString().slice(0, 10) as LocalDate;
}

/** Search the next civil-day boundary, including 23/25-hour DST days. */
export function millisecondsUntilNextSharedDay(now: Date, timeZone: string): number {
  const today = sharedLocalDate(now, timeZone); let low = now.getTime(); let high = low + 27 * 60 * 60_000;
  if (!Number.isFinite(low)) throw new Error('Invalid group clock');
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2);
    if (sharedLocalDate(new Date(middle), timeZone) === today) low = middle;
    else high = middle;
  }
  return high - now.getTime();
}

/** DST folds use the first occurrence; a missing clock time moves forward by the DST gap. */
export function sharedDateAtTime(date: LocalDate, hour: number, minute: number, timeZone: string): Date {
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59) throw new Error('Invalid shared reminder time');
  const zone = zoneFor(timeZone);
  const civil = (instant: number) => instant - zone.utcOffset(instant) * 60_000;
  const target = Date.parse(`${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00Z`);
  if (!Number.isFinite(target)) throw new Error('Invalid shared reminder date');
  const offsets = new Set<number>();
  for (let delta = -36; delta <= 36; delta += 12) { const instant = target + delta * 3600_000; offsets.add(civil(instant) - instant); }
  const candidates = [...offsets].map((offset) => target - offset);
  const exact = candidates.filter((instant) => civil(instant) === target);
  if (exact.length) return new Date(Math.min(...exact));
  const later = candidates.filter((instant) => civil(instant) > target && sharedLocalDate(new Date(instant), timeZone) === date);
  if (!later.length) throw new Error('This civil date does not exist in the group timezone');
  return new Date(later.sort((left, right) => civil(left) - civil(right) || left - right)[0]);
}
