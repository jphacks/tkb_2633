import { addDays, daysBetween, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { v2OccurrenceId } from './occurrence-id.ts';
import type { SharedChoreConfiguration, SharedOccurrence } from './model.ts';

/** Common anchors depend only on the signed configuration, never on an individual's recommendation or completion. */
export function commonFrame(groupId: string, choreId: string, configuration: SharedChoreConfiguration, anchorDate: LocalDate): SharedOccurrence {
  parseLocalDate(configuration.anchorDate); parseLocalDate(anchorDate);
  if (!Number.isSafeInteger(configuration.intervalDays) || configuration.intervalDays < 1 || configuration.intervalDays > 3650
    || !Number.isSafeInteger(configuration.ruleVersion) || configuration.ruleVersion < 1
    || [configuration.windowBeforeDays, configuration.windowAfterDays].some((days) => !Number.isSafeInteger(days) || days < 0 || days > 14)) throw new Error('Invalid common recurrence');
  const difference = daysBetween(configuration.anchorDate, anchorDate);
  if (difference < 0 || difference % configuration.intervalDays !== 0) throw new Error('Anchor is not a common occurrence');
  return { id: v2OccurrenceId(groupId, choreId, anchorDate), choreId, anchorDate,
    windowStart: addDays(anchorDate, -configuration.windowBeforeDays), windowEnd: addDays(anchorDate, configuration.windowAfterDays), ruleVersion: configuration.ruleVersion };
}
export function commonFrames(groupId: string, choreId: string, configuration: SharedChoreConfiguration,
  from: LocalDate, through: LocalDate): SharedOccurrence[] {
  parseLocalDate(from); parseLocalDate(through);
  if (through < from || daysBetween(from, through) > 3650) throw new Error('Invalid common planning horizon');
  commonFrame(groupId, choreId, configuration, configuration.anchorDate);
  const first = Math.max(0, Math.ceil(daysBetween(configuration.anchorDate, from) / configuration.intervalDays));
  const result: SharedOccurrence[] = [];
  for (let index = first; ; index++) {
    const anchor = addDays(configuration.anchorDate, index * configuration.intervalDays);
    if (anchor > through) break;
    result.push(commonFrame(groupId, choreId, configuration, anchor));
  }
  return result;
}
