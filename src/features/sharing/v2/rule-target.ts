import moment from 'moment-timezone';
import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedDateAtTime, sharedLocalDate } from '../group-clock.ts';
import { instantMilliseconds, normalizeDateTarget } from './date-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

/** D6: repeat a civil-day offset and local clock, not an absolute date or a 24-hour UTC increment. */
export function materializeRuleTarget(rule: ManualRule, occurrence: SharedOccurrence, timeZone: string):
  { kind: 'target'; target: DateTarget } | { kind: 'review'; reason: 'cycleChanged' | 'timeZoneChanged' | 'invalidInterval' } {
  const target = normalizeDateTarget(rule.target);
  if (rule.selector.scope === 'once') {
    if (rule.selector.occurrenceId !== occurrence.id || rule.selector.anchorDate !== occurrence.anchorDate) throw new Error('One-off rule belongs to another occurrence');
    return { kind: 'target', target };
  }
  if (rule.ruleVersion !== occurrence.ruleVersion) return { kind: 'review', reason: 'cycleChanged' };
  if (target.precision !== 'date' && rule.timeZoneAtCreation !== timeZone) return { kind: 'review', reason: 'timeZoneChanged' };
  const delta = daysBetween(rule.referenceAnchorDate, occurrence.anchorDate);
  if (target.precision === 'date') return { kind: 'target', target: { precision: 'date', date: addDays(target.date, delta) } };
  const shift = (timestamp: string) => {
    const instant = instantMilliseconds(timestamp); const zone = moment.tz.zone(timeZone);
    if (!zone) throw new Error('Unsupported shared timezone');
    const civil = new Date(instant - zone.utcOffset(instant) * 60_000);
    const date = addDays(sharedLocalDate(new Date(instant), timeZone), delta);
    const shifted = sharedDateAtTime(date, civil.getUTCHours(), civil.getUTCMinutes(), timeZone).getTime()
      + civil.getUTCSeconds() * 1000 + civil.getUTCMilliseconds();
    const shiftedCivil = new Date(shifted - zone.utcOffset(shifted) * 60_000);
    if (sharedLocalDate(new Date(shifted), timeZone) !== date || shiftedCivil.getUTCHours() !== civil.getUTCHours()
      || shiftedCivil.getUTCMinutes() !== civil.getUTCMinutes()) return null;
    return new Date(shifted).toISOString();
  };
  if (target.precision === 'instant') {
    const at = shift(target.at); return at ? { kind: 'target', target: { precision: 'instant', at } } : { kind: 'review', reason: 'invalidInterval' };
  }
  const start = shift(target.start); const end = shift(target.end);
  if (!start || !end) return { kind: 'review', reason: 'invalidInterval' };
  if (Date.parse(end) <= Date.parse(start)) return { kind: 'review', reason: 'invalidInterval' };
  return { kind: 'target', target: { precision: 'interval', start, end } };
}
