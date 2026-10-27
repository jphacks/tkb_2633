import moment from 'moment-timezone';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { v2WallTimeCandidates } from '../v2/local-time.ts';
import type { DateTarget, DesignationMode, RuleSelector, SharedOccurrence } from '../v2/model.ts';
import { normalizeDateTarget, validateDesignationTarget } from '../v2/date-target.ts';
import { finiteValidity } from '../v2/period-rules.ts';

export function v2DateInput(value: string): LocalDate {
  try { parseLocalDate(value as LocalDate); } catch { throw new Error('日付は年-月-日（例：2026-10-28）で入力してください。'); }
  return value as LocalDate;
}

export function v2LocalTimeChoices(date: string, time: string, timeZone: string): { value: string; label: string }[] {
  v2DateInput(date);
  const parts = /^(\d{2}):(\d{2})$/u.exec(time); if (!parts) throw new Error('時刻は時:分（例：19:00）で入力してください。');
  if (Number(parts[1]) > 23 || Number(parts[2]) > 59) throw new Error('時刻は00:00〜23:59で入力してください。');
  const matches = v2WallTimeCandidates({ date: date as LocalDate, hour: Number(parts[1]), minute: Number(parts[2]), timeZone });
  if (!matches.length) throw new Error('この地域には存在しない時刻です。別の時刻を選んでください。');
  return matches.map((at, index) => ({ value: new Date(at).toISOString(), label: `${index + 1}回目（UTC${moment(at).tz(timeZone).format('Z')}）` }));
}
export function v2LocalTimeInput(date: string, time: string, timeZone: string, choice?: string): string {
  const candidates = v2LocalTimeChoices(date, time, timeZone);
  if (choice) { if (candidates.some((candidate) => candidate.value === choice)) return choice; throw new Error('入力した日時に合う時刻の区別を選び直してください。'); }
  if (candidates.length > 1) throw new Error('この時刻は複数回あります。どの時刻か選んでください。');
  if (!candidates.length) throw new Error('この地域には存在しない時刻です。別の時刻を選んでください。');
  return candidates[0].value;
}
export function v2TargetFromForm(input: { mode: DesignationMode; day: string; clock: string; endDay: string; endClock: string; timeZone: string;
  clockChoice?: string; endClockChoice?: string }): DateTarget {
  v2DateInput(input.day);
  return validateDesignationTarget(input.mode, input.mode === 'fixed'
    ? { precision: 'interval', start: v2LocalTimeInput(input.day, input.clock, input.timeZone, input.clockChoice), end: v2LocalTimeInput(input.endDay, input.endClock, input.timeZone, input.endClockChoice) }
    : input.mode === 'deadline' && input.clock.trim() ? { precision: 'instant', at: v2LocalTimeInput(input.day, input.clock, input.timeZone, input.clockChoice) }
      : { precision: 'date', date: input.day as LocalDate });
}
/** Preserve each unchanged endpoint, including seconds and the selected repeated hour, independently. */
export function v2TargetFromEditedForm(input: Parameters<typeof v2TargetFromForm>[0], original: DateTarget,
  initial: ReturnType<typeof v2TargetFormValues> & { clockChoice: string; endClockChoice: string }): DateTarget {
  const previous = normalizeDateTarget(original); v2DateInput(input.day);
  const unchangedStart = input.day === initial.day && input.clock === initial.clock && (input.clockChoice ?? '') === initial.clockChoice;
  const unchangedEnd = input.endDay === initial.endDay && input.endClock === initial.endClock && (input.endClockChoice ?? '') === initial.endClockChoice;
  const start = () => unchangedStart && previous.precision !== 'date' ? previous.precision === 'interval' ? previous.start : previous.at
    : v2LocalTimeInput(input.day, input.clock, input.timeZone, input.clockChoice);
  const end = () => unchangedEnd && previous.precision === 'interval' ? previous.end : v2LocalTimeInput(input.endDay, input.endClock, input.timeZone, input.endClockChoice);
  return validateDesignationTarget(input.mode, input.mode === 'fixed' ? { precision: 'interval', start: start(), end: end() }
    : input.mode === 'deadline' && input.clock.trim() ? { precision: 'instant', at: start() } : { precision: 'date', date: input.day as LocalDate });
}

export type V2ValidityChoice = 'once' | 'twoWeeks' | 'oneMonth' | 'endDate' | 'ongoing';
export function v2RuleSelectorFromForm(selection: V2ValidityChoice, round: SharedOccurrence, endDate: string): RuleSelector {
  if (selection === 'once') return { scope: 'once', occurrenceId: round.id, anchorDate: round.anchorDate };
  if (selection === 'ongoing') return { scope: 'ongoing', from: round.anchorDate };
  return { scope: 'period', range: finiteValidity(round.anchorDate, selection, selection === 'endDate' ? v2DateInput(endDate) : undefined) };
}
export function v2TargetFormValues(target: DateTarget, timeZone: string) {
  if (target.precision === 'date') return { day: target.date as string, clock: '', endDay: target.date as string, endClock: '' };
  const start = moment(target.precision === 'instant' ? target.at : target.start).tz(timeZone);
  const end = target.precision === 'interval' ? moment(target.end).tz(timeZone) : null;
  return { day: start.format('YYYY-MM-DD'), clock: start.format('HH:mm'), endDay: end?.format('YYYY-MM-DD') ?? start.format('YYYY-MM-DD'), endClock: end?.format('HH:mm') ?? '' };
}
export function v2TargetLabel(target: DateTarget, timeZone: string): string {
  if (target.precision === 'date') { const date = parseLocalDate(target.date); return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`; }
  const label = (at: string) => moment(at).tz(timeZone).format('M月D日 HH:mm');
  return target.precision === 'instant' ? label(target.at) : `${label(target.start)}〜${label(target.end)}`;
}
