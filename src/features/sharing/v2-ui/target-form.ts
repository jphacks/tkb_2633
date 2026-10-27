import moment from 'moment-timezone';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { sharedDateAtTime } from '../group-clock.ts';
import type { DateTarget, DesignationMode } from '../v2/model.ts';
import { validateDesignationTarget } from '../v2/date-target.ts';

export function v2LocalTimeInput(date: string, time: string, timeZone: string): string {
  parseLocalDate(date as LocalDate);
  const parts = /^(\d{2}):(\d{2})$/u.exec(time); if (!parts) throw new Error('時刻は時:分（例：19:00）で入力してください。');
  const instant = sharedDateAtTime(date as LocalDate, Number(parts[1]), Number(parts[2]), timeZone);
  if (moment(instant).tz(timeZone).format('YYYY-MM-DD HH:mm') !== `${date} ${time}`) throw new Error('この地域には存在しない時刻です。別の時刻を選んでください。');
  return instant.toISOString();
}
export function v2TargetFromForm(input: { mode: DesignationMode; day: string; clock: string; endDay: string; endClock: string; timeZone: string }): DateTarget {
  parseLocalDate(input.day as LocalDate);
  return validateDesignationTarget(input.mode, input.mode === 'fixed'
    ? { precision: 'interval', start: v2LocalTimeInput(input.day, input.clock, input.timeZone), end: v2LocalTimeInput(input.endDay, input.endClock, input.timeZone) }
    : input.mode === 'deadline' && input.clock.trim() ? { precision: 'instant', at: v2LocalTimeInput(input.day, input.clock, input.timeZone) }
      : { precision: 'date', date: input.day as LocalDate });
}
export function v2TargetLabel(target: DateTarget, timeZone: string): string {
  if (target.precision === 'date') { const date = parseLocalDate(target.date); return `${date.getUTCMonth() + 1}月${date.getUTCDate()}日`; }
  const label = (at: string) => moment(at).tz(timeZone).format('M月D日 HH:mm');
  return target.precision === 'instant' ? label(target.at) : `${label(target.start)}〜${label(target.end)}`;
}
