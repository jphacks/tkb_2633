import moment from 'moment-timezone';
import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2WallTimeCandidates } from './local-time.ts';
import { instantMilliseconds, normalizeDateTarget, targetReferenceTime } from './date-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

export type V2RuleTargetCandidates = { kind: 'targets'; targets: DateTarget[] }
  | { kind: 'missingTime'; referenceTimes: number[] } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' };

/** D9: an authenticated rule keeps its original civil clock, including gaps/folds, after a group-region change. */
export function v2RuleTargetCandidates(rule: ManualRule, occurrence: SharedOccurrence, _displayTimeZone: string): V2RuleTargetCandidates {
  const target = normalizeDateTarget(rule.target);
  if (rule.selector.scope === 'once') {
    if (rule.selector.occurrenceId !== occurrence.id || rule.selector.anchorDate !== occurrence.anchorDate) throw new Error('One-off rule belongs to another occurrence');
    return { kind: 'targets', targets: [target] };
  }
  if (rule.ruleVersion !== occurrence.ruleVersion) return { kind: 'review', reason: 'cycleChanged' };
  const timeZone = rule.timeZoneAtCreation;
  const delta = daysBetween(rule.referenceAnchorDate, occurrence.anchorDate);
  if (target.precision === 'date') {
    const shifted = { precision: 'date' as const, date: addDays(target.date, delta) };
    try { targetReferenceTime(shifted, timeZone); }
    catch { return { kind: 'missingTime', referenceTimes: [] }; }
    return { kind: 'targets', targets: [shifted] };
  }
  if (delta === 0) return { kind: 'targets', targets: [target] };
  const shift = (timestamp: string): string[] => {
    const instant = instantMilliseconds(timestamp); const zone = moment.tz.zone(timeZone);
    if (!zone) throw new Error('Unsupported shared timezone');
    const civil = new Date(instant - zone.utcOffset(instant) * 60_000);
    const date = addDays(sharedLocalDate(new Date(instant), timeZone), delta);
    return v2WallTimeCandidates({ date, hour: civil.getUTCHours(), minute: civil.getUTCMinutes(), timeZone,
      second: civil.getUTCSeconds(), millisecond: civil.getUTCMilliseconds() }).map((value) => new Date(value).toISOString());
  };
  if (target.precision === 'instant') {
    const values = shift(target.at);
    return values.length ? { kind: 'targets', targets: values.map((at) => ({ precision: 'instant', at })) } : { kind: 'missingTime', referenceTimes: [] };
  }
  const starts = shift(target.start); const ends = shift(target.end);
  if (!starts.length || !ends.length) return { kind: 'missingTime', referenceTimes: starts.map((at) => instantMilliseconds(at)) };
  const targets: DateTarget[] = starts.flatMap((start) => ends.filter((end) => Date.parse(end) > Date.parse(start)).map((end) => ({ precision: 'interval' as const, start, end })));
  return targets.length ? { kind: 'targets', targets } : { kind: 'review', reason: 'invalidInterval' };
}

/** Inverse calendar query with conservative tzdb offset bounds, rather than the first occurrence's display-day offset.
 * Source and display regions can cross midnight on different dates after DST or a date-line change. */
export function v2RuleCalendarAnchorRange(rule: ManualRule, from: LocalDate, through: LocalDate, displayTimeZone: string) {
  const target = normalizeDateTarget(rule.target);
  if (target.precision === 'date' && rule.mode !== 'deadline') {
    const delta = daysBetween(rule.referenceAnchorDate, target.date);
    return { from: addDays(from, -delta), through: addDays(through, -delta) };
  }
  const source = moment.tz.zone(rule.timeZoneAtCreation); const display = moment.tz.zone(displayTimeZone);
  if (!source || !display) throw new Error('Unsupported shared timezone');
  const at = targetReferenceTime(target, rule.timeZoneAtCreation);
  const sourceWall = at - source.utcOffset(at) * 60_000;
  const shift = sourceWall - parseLocalDate(rule.referenceAnchorDate).getTime();
  const minimum = shift + (Math.min(...source.offsets) - Math.max(...display.offsets)) * 60_000;
  const maximum = shift + (Math.max(...source.offsets) - Math.min(...display.offsets)) * 60_000;
  const day = 86_400_000;
  const date = (value: number) => { const result = new Date(value).toISOString().slice(0, 10) as LocalDate; parseLocalDate(result); return result; };
  return { from: date(Math.ceil((parseLocalDate(from).getTime() - maximum) / day) * day),
    through: date((Math.ceil((parseLocalDate(through).getTime() + day - minimum) / day) - 1) * day) };
}

/** D6: repeat civil clocks; D7: keep missing times unresolved until a receipt-backed request is approved. */
export function materializeRuleTarget(rule: ManualRule, occurrence: SharedOccurrence, timeZone: string):
  { kind: 'target'; target: DateTarget } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' | 'ambiguousTime' } {
  const result = v2RuleTargetCandidates(rule, occurrence, timeZone);
  if (result.kind === 'review') return result;
  if (result.kind === 'missingTime') return { kind: 'review', reason: 'invalidInterval' };
  return result.targets.length === 1 ? { kind: 'target', target: result.targets[0] } : { kind: 'review', reason: 'ambiguousTime' };
}
