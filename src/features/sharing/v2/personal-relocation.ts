import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { sharedDateAtTime, sharedLocalDate } from '../group-clock.ts';
import { intervalsOverlap } from './date-target.ts';
import { mergeInstantRanges } from './private-availability.ts';
import type { GroupKind, InstantRange } from './model.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

export interface PersonalRelocationInput {
  groupKind: GroupKind; fromGroupAdmin: boolean; personConsented: boolean;
  automatic: boolean; manuallyFixed: boolean; completed: boolean;
  original: InstantRange; sharedFixed: InstantRange;
  windowStart: LocalDate; windowEnd: LocalDate; timeZone: string;
  allowedWindows: readonly InstantRange[];
  fixedAndBusyIntervals: readonly InstantRange[];
  calendarConfirmed: boolean; now: number;
}
export type PersonalRelocation = { kind: 'unchanged' | 'protected' | 'requiresConsent' }
  | { kind: 'needsReview'; reason: 'missingAllowedTimes' | 'ambiguousAllowedTimes' | 'unconfirmedCalendar' | 'noSlot' }
  | { kind: 'moved'; original: InstantRange; proposed: InstantRange; reason: 'sharedFixedConflict' };

/** Consumes only this person's private inputs; callers persist the reason only in their private DB. */
export function proposePersonalRelocation(input: PersonalRelocationInput): PersonalRelocation {
  const range = (value: InstantRange): InstantRange => {
    if (!value || typeof value !== 'object' || Object.keys(value).sort().join(',') !== 'end,start'
      || ![value.start, value.end].every(at => Number.isFinite(at) && Number.isFinite(new Date(at).getTime())) || value.start >= value.end) throw new Error('個人家事の開始・終了時刻を確認してください。');
    return { start: value.start, end: value.end };
  };
  if (!['family', 'roommates'].includes(input.groupKind) || ![input.fromGroupAdmin, input.personConsented, input.automatic,
    input.manuallyFixed, input.completed, input.calendarConfirmed].every(value => typeof value === 'boolean')) throw new Error('個人家事を移動する権限・状態を確認してください。');
  input = { ...input, original: range(input.original), sharedFixed: range(input.sharedFixed) };
  if (!intervalsOverlap(input.original, input.sharedFixed)) return { kind: 'unchanged' };
  if (!input.automatic || input.manuallyFixed || input.completed) return { kind: 'protected' };
  if (input.groupKind === 'roommates' && !input.personConsented || input.groupKind === 'family' && !input.fromGroupAdmin) return { kind: 'requiresConsent' };
  if (!input.allowedWindows.length) return { kind: 'needsReview', reason: 'missingAllowedTimes' };
  if (!input.calendarConfirmed) return { kind: 'needsReview', reason: 'unconfirmedCalendar' };
  parseLocalDate(input.windowStart); parseLocalDate(input.windowEnd);
  if (input.windowStart > input.windowEnd || !Number.isFinite(input.now)) throw new Error('個人家事の実施期間を確認してください。');
  const allowedStart = sharedDateAtTime(input.windowStart, 0, 0, input.timeZone).getTime();
  const allowedEnd = sharedDateAtTime(addDays(input.windowEnd, 1), 0, 0, input.timeZone).getTime();
  const sameDay = sharedLocalDate(new Date(input.original.start), input.timeZone);
  const dayStart = sharedDateAtTime(sameDay, 0, 0, input.timeZone).getTime();
  const dayEnd = sharedDateAtTime(addDays(sameDay, 1), 0, 0, input.timeZone).getTime();
  const windows = mergeInstantRanges(input.allowedWindows.map(range)).map((range) => ({ start: Math.max(range.start, allowedStart, input.now), end: Math.min(range.end, allowedEnd) }))
    .filter((range) => range.start < range.end);
  const sameDayWindows = windows.map((range) => ({ start: Math.max(range.start, dayStart), end: Math.min(range.end, dayEnd) })).filter((range) => range.start < range.end);
  const blocked = mergeInstantRanges([...input.fixedAndBusyIntervals.map(range), input.sharedFixed]);
  const duration = input.original.end - input.original.start;
  for (const window of [...sameDayWindows, ...windows]) {
    let cursor = window.start;
    for (const range of blocked) {
      if (range.end <= cursor) continue;
      if (range.start >= window.end || range.start - cursor >= duration) break;
      cursor = Math.max(cursor, range.end);
    }
    if (cursor + duration <= window.end) return { kind: 'moved', original: { ...input.original },
      proposed: { start: cursor, end: cursor + duration }, reason: 'sharedFixedConflict' };
  }
  return { kind: 'needsReview', reason: 'noSlot' };
}
