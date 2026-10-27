import moment from 'moment-timezone';
import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2WallTimeCandidates } from './local-time.ts';
import { instantMilliseconds, normalizeDateTarget } from './date-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

export type V2RuleTargetCandidates = { kind: 'targets'; targets: DateTarget[] }
  | { kind: 'missingTime' } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' };

/** Exact possible instants in the pinned group timezone; a gap is distinct from an invalid interval or changed rule. */
export function v2RuleTargetCandidates(rule: ManualRule, occurrence: SharedOccurrence, timeZone: string): V2RuleTargetCandidates {
  const target = normalizeDateTarget(rule.target);
  if (rule.selector.scope === 'once') {
    if (rule.selector.occurrenceId !== occurrence.id || rule.selector.anchorDate !== occurrence.anchorDate) throw new Error('One-off rule belongs to another occurrence');
    return { kind: 'targets', targets: [target] };
  }
  if (rule.ruleVersion !== occurrence.ruleVersion) return { kind: 'review', reason: 'cycleChanged' };
  if (target.precision !== 'date' && rule.timeZoneAtCreation !== timeZone) return { kind: 'review', reason: 'timeZoneChanged' };
  const delta = daysBetween(rule.referenceAnchorDate, occurrence.anchorDate);
  if (target.precision === 'date') return { kind: 'targets', targets: [{ precision: 'date', date: addDays(target.date, delta) }] };
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
    return values.length ? { kind: 'targets', targets: values.map((at) => ({ precision: 'instant', at })) } : { kind: 'missingTime' };
  }
  const starts = shift(target.start); const ends = shift(target.end);
  if (!starts.length || !ends.length) return { kind: 'missingTime' };
  const targets: DateTarget[] = starts.flatMap((start) => ends.filter((end) => Date.parse(end) > Date.parse(start)).map((end) => ({ precision: 'interval' as const, start, end })));
  return targets.length ? { kind: 'targets', targets } : { kind: 'review', reason: 'invalidInterval' };
}

/** D6: repeat civil clocks; D7: keep missing times unresolved until a receipt-backed request is approved. */
export function materializeRuleTarget(rule: ManualRule, occurrence: SharedOccurrence, timeZone: string):
  { kind: 'target'; target: DateTarget } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' | 'ambiguousTime' } {
  const result = v2RuleTargetCandidates(rule, occurrence, timeZone);
  if (result.kind === 'review') return result;
  if (result.kind === 'missingTime') return { kind: 'review', reason: 'invalidInterval' };
  return result.targets.length === 1 ? { kind: 'target', target: result.targets[0] } : { kind: 'review', reason: 'ambiguousTime' };
}
