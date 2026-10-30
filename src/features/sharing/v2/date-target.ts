import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { sharedDateAtTime, sharedLocalDate } from '../group-clock.ts';
import type { DateTarget, DesignationMode, InstantRange } from './model.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

export function instantMilliseconds(value: string): number {
  const parts = typeof value === 'string' && /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(Z|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts) throw new Error('タイムゾーン付きの日時を確認してください。');
  parseLocalDate(parts[1] as LocalDate);
  if (Number(parts[2]) > 23 || Number(parts[3]) > 59 || Number(parts[4]) > 59) throw new Error('時刻を確認してください。');
  const result = Date.parse(value);
  if (!Number.isFinite(result)) throw new Error('日時を確認してください。');
  return result;
}
export function normalizeDateTarget(input: DateTarget): DateTarget {
  if (!input || typeof input !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(input))) throw new Error('日時の形式を確認してください。');
  if (input.precision === 'date' && Object.keys(input).sort().join(',') === 'date,precision') {
    parseLocalDate(input.date); return { precision: 'date', date: input.date };
  }
  if (input.precision === 'instant' && Object.keys(input).sort().join(',') === 'at,precision') {
    return { precision: 'instant', at: new Date(instantMilliseconds(input.at)).toISOString() };
  }
  if (input.precision === 'interval' && Object.keys(input).sort().join(',') === 'end,precision,start') {
    const start = instantMilliseconds(input.start); const end = instantMilliseconds(input.end);
    if (end <= start) throw new Error('終了は開始より後にしてください。');
    return { precision: 'interval', start: new Date(start).toISOString(), end: new Date(end).toISOString() };
  }
  throw new Error('日時の形式を確認してください。');
}
export function validateDesignationTarget(mode: DesignationMode, input: DateTarget): DateTarget {
  const target = normalizeDateTarget(input);
  if (mode === 'day' && target.precision === 'date' || mode === 'fixed' && target.precision === 'interval'
    || mode === 'deadline' && target.precision !== 'interval') return target;
  throw new Error('期限・実施日・固定日時に合う指定を選んでください。');
}
/** A date-only target uses the agreed 23:59, not a host-device day boundary. */
export function targetReferenceTime(input: DateTarget, timeZone: string): number {
  const target = normalizeDateTarget(input);
  if (target.precision === 'date') return sharedDateAtTime(target.date, 23, 59, timeZone).getTime();
  return instantMilliseconds(target.precision === 'instant' ? target.at : target.start);
}
export function targetCivilDate(input: DateTarget, timeZone: string) {
  const target = normalizeDateTarget(input);
  return target.precision === 'date' ? target.date : sharedLocalDate(new Date(targetReferenceTime(target, timeZone)), timeZone);
}
/** A date-only deadline has a real 23:59 boundary in its source region; display regions can call it the previous day. */
export function targetReferenceCivilDate(input: DateTarget, sourceTimeZone: string, displayTimeZone: string) {
  return sharedLocalDate(new Date(targetReferenceTime(input, sourceTimeZone)), displayTimeZone);
}
export function fixedInterval(input: DateTarget): InstantRange | null {
  const target = normalizeDateTarget(input);
  return target.precision === 'interval' ? { start: instantMilliseconds(target.start), end: instantMilliseconds(target.end) } : null;
}
export function intervalsOverlap(left: InstantRange, right: InstantRange): boolean {
  if (![left.start, left.end, right.start, right.end].every(Number.isFinite) || left.start >= left.end || right.start >= right.end) throw new Error('時間帯を確認してください。');
  return left.start < right.end && right.start < left.end;
}
export function fixedAssignmentsOverlap(left: { target: DateTarget; assigneeIds: readonly string[] }, right: { target: DateTarget; assigneeIds: readonly string[] }): boolean {
  const first = fixedInterval(left.target); const second = fixedInterval(right.target);
  return Boolean(first && second && left.assigneeIds.some((id) => right.assigneeIds.includes(id)) && intervalsOverlap(first, second));
}
