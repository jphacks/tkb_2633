import { CALENDAR_AVAILABILITY_MAX_AGE_MS } from '../../google-sync/calendar-timing.ts';
import { fixedInterval, instantMilliseconds, intervalsOverlap } from './date-target.ts';
import type { DateTarget, InstantRange } from './model.ts';
import { isSharedTimeZone } from '../group-clock.ts';
import { assertSharedIdentifier } from '../identifier.ts';

/** Private account data. This type is never an allowed shared-operation payload. */
export interface PrivateBusyCache {
  ownerUserId: string;
  accountGeneration: string;
  mainDeviceId: string;
  mainRevision: number;
  calendarBinding: string;
  timeZone: string;
  fetchedAt: string;
  coverage: { start: string; end: string };
  intervals: { start: string; end: string }[];
}
export type PrivateBusyBinding = Pick<PrivateBusyCache, 'ownerUserId' | 'accountGeneration' | 'mainDeviceId' | 'mainRevision' | 'calendarBinding'>;
export type CalendarConflict = { kind: 'conflict' | 'clear' } | { kind: 'unknown'; reason: 'missing' | 'binding' | 'stale' | 'coverage' | 'invalid' | 'timeNotSpecified' };

export function mergeInstantRanges(input: readonly InstantRange[]): InstantRange[] {
  const sorted = input.map((range) => {
    if (![range.start, range.end].every(Number.isFinite) || range.start >= range.end) throw new Error('無効な時間帯です。');
    return { ...range };
  }).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: InstantRange[] = [];
  for (const range of sorted) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push(range);
  }
  return merged;
}
export function validatedPrivateBusyIntervals(cache: PrivateBusyCache): InstantRange[] {
  if (Object.keys(cache).sort().join(',') !== 'accountGeneration,calendarBinding,coverage,fetchedAt,intervals,mainDeviceId,mainRevision,ownerUserId,timeZone'
    || !isSharedTimeZone(cache.timeZone) || !Array.isArray(cache.intervals) || cache.intervals.length > 20_000
    || !Number.isSafeInteger(cache.mainRevision) || cache.mainRevision < 1) throw new Error('本人用Calendar情報を確認できません。');
  for (const name of ['ownerUserId', 'accountGeneration', 'mainDeviceId', 'calendarBinding'] as const) assertSharedIdentifier(cache[name]);
  if (Object.keys(cache.coverage).sort().join(',') !== 'end,start') throw new Error('Calendarの取得範囲が無効です。');
  const start = instantMilliseconds(cache.coverage.start); const end = instantMilliseconds(cache.coverage.end);
  if (start >= end) throw new Error('Calendarの取得範囲が無効です。');
  return mergeInstantRanges(cache.intervals.map((interval) => {
    if (Object.keys(interval).sort().join(',') !== 'end,start') throw new Error('Calendarの時間帯が無効です。');
    const from = instantMilliseconds(interval.start); const through = instantMilliseconds(interval.end);
    if (from >= through) throw new Error('Calendarの時間帯が無効です。');
    return { start: Math.max(from, start), end: Math.min(through, end) };
  }).filter((range) => range.start < range.end));
}
/** A local, account-bound check returns only the result, never the private intervals. */
export function checkPrivateCalendarConflict(cache: PrivateBusyCache | null, expected: PrivateBusyBinding, target: DateTarget, now: number): CalendarConflict {
  if (!cache) return { kind: 'unknown', reason: 'missing' };
  if (!['ownerUserId', 'accountGeneration', 'mainDeviceId', 'calendarBinding'].every((key) => typeof expected[key as keyof PrivateBusyBinding] === 'string'
    && expected[key as keyof PrivateBusyBinding] !== '') || !Number.isSafeInteger(expected.mainRevision) || expected.mainRevision < 1) return { kind: 'unknown', reason: 'binding' };
  if (Object.entries(expected).some(([key, value]) => cache[key as keyof PrivateBusyBinding] !== value)) return { kind: 'unknown', reason: 'binding' };
  try {
    const fetchedAt = instantMilliseconds(cache.fetchedAt);
    if (!Number.isFinite(now) || fetchedAt > now || now - fetchedAt > CALENDAR_AVAILABILITY_MAX_AGE_MS) return { kind: 'unknown', reason: 'stale' };
    const interval = fixedInterval(target);
    if (!interval) return { kind: 'unknown', reason: 'timeNotSpecified' };
    if (instantMilliseconds(cache.coverage.start) > interval.start || instantMilliseconds(cache.coverage.end) < interval.end) return { kind: 'unknown', reason: 'coverage' };
    const busy = validatedPrivateBusyIntervals(cache);
    return { kind: busy.some((range) => intervalsOverlap(range, interval)) ? 'conflict' : 'clear' };
  } catch { return { kind: 'unknown', reason: 'invalid' }; }
}
