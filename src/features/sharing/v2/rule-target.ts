import moment from 'moment-timezone';
import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2WallTimeCandidates } from './local-time.ts';
import { instantMilliseconds, normalizeDateTarget } from './date-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

/** D6: repeat a civil-day offset and local clock, not an absolute date or a 24-hour UTC increment. */
export function materializeRuleTarget(rule: ManualRule, occurrence: SharedOccurrence, timeZone: string):
  { kind: 'target'; target: DateTarget } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' | 'ambiguousTime' } {
  const target = normalizeDateTarget(rule.target);
  if (rule.selector.scope === 'once') {
    if (rule.selector.occurrenceId !== occurrence.id || rule.selector.anchorDate !== occurrence.anchorDate) throw new Error('One-off rule belongs to another occurrence');
    return { kind: 'target', target };
  }
  if (rule.ruleVersion !== occurrence.ruleVersion) return { kind: 'review', reason: 'cycleChanged' };
  if (target.precision !== 'date' && rule.timeZoneAtCreation !== timeZone) return { kind: 'review', reason: 'timeZoneChanged' };
  const delta = daysBetween(rule.referenceAnchorDate, occurrence.anchorDate);
  if (target.precision === 'date') return { kind: 'target', target: { precision: 'date', date: addDays(target.date, delta) } };
  if (delta === 0) return { kind: 'target', target };
  let ambiguous = false;
  const shift = (timestamp: string) => {
    const instant = instantMilliseconds(timestamp); const zone = moment.tz.zone(timeZone);
    if (!zone) throw new Error('Unsupported shared timezone');
    const civil = new Date(instant - zone.utcOffset(instant) * 60_000);
    const date = addDays(sharedLocalDate(new Date(instant), timeZone), delta);
    const candidates = v2WallTimeCandidates({ date, hour: civil.getUTCHours(), minute: civil.getUTCMinutes(), timeZone,
      second: civil.getUTCSeconds(), millisecond: civil.getUTCMilliseconds() });
    if (candidates.length !== 1) { ambiguous ||= candidates.length > 1; return null; }
    return new Date(candidates[0]).toISOString();
  };
  if (target.precision === 'instant') {
    const at = shift(target.at); return at ? { kind: 'target', target: { precision: 'instant', at } } : { kind: 'review', reason: ambiguous ? 'ambiguousTime' : 'invalidInterval' };
  }
  const start = shift(target.start); const end = shift(target.end);
  if (!start || !end) return { kind: 'review', reason: ambiguous ? 'ambiguousTime' : 'invalidInterval' };
  if (Date.parse(end) <= Date.parse(start)) return { kind: 'review', reason: 'invalidInterval' };
  return { kind: 'target', target: { precision: 'interval', start, end } };
}
