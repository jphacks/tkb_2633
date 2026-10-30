import type { LocalDate, Weekday } from '../../../domain/shared/types.ts';
import { addDays, parseLocalDate, weekdayOf, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { isSharedTimeZone } from '../group-clock.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { v2WallTimeCandidates } from '../v2/local-time.ts';
import { mergeInstantRanges } from '../v2/private-availability.ts';
import type { InstantRange } from '../v2/model.ts';

export interface PrivateAllowedBand { weekday: Weekday; startMinute: number; endMinute: number }
export interface PrivatePlannerPreferences {
  timeZone: string; restDays: Weekday[];
  loadLimits: { heavyDailyLimit: number; normalDailyLimit: number };
  allowedBands: PrivateAllowedBand[];
}
export interface SavedPrivatePlannerPreferences extends PrivatePlannerPreferences {
  schemaVersion: 1; ownerUserId: string; revision: number;
}
const fields = (value: unknown, keys: string[]): value is Record<string, unknown> => Boolean(value && typeof value === 'object'
  && !Array.isArray(value) && Object.keys(value).sort().join(',') === keys.sort().join(','));
const weekday = (value: unknown): value is Weekday => Number.isInteger(value) && Number(value) >= 1 && Number(value) <= 7;

/** Private input only. No group operation, shared hash, token or Google account belongs here. */
export function snapshotPrivatePlannerPreferences(value: PrivatePlannerPreferences): PrivatePlannerPreferences {
  if (!fields(value, ['timeZone', 'restDays', 'loadLimits', 'allowedBands']) || !isSharedTimeZone(value.timeZone)
    || !Array.isArray(value.restDays) || value.restDays.length > 7 || !value.restDays.every(weekday)
    || !fields(value.loadLimits, ['heavyDailyLimit', 'normalDailyLimit'])
    || !Number.isSafeInteger(value.loadLimits.heavyDailyLimit) || Number(value.loadLimits.heavyDailyLimit) < 1 || Number(value.loadLimits.heavyDailyLimit) > 10
    || !Number.isSafeInteger(value.loadLimits.normalDailyLimit) || Number(value.loadLimits.normalDailyLimit) < 1 || Number(value.loadLimits.normalDailyLimit) > 20
    || !Array.isArray(value.allowedBands) || value.allowedBands.length > 56) throw new Error('本人の休日・実施可能時間帯を確認してください。');
  const bands = value.allowedBands.map(band => {
    if (!fields(band, ['weekday', 'startMinute', 'endMinute']) || !weekday(band.weekday)
      || !Number.isInteger(band.startMinute) || !Number.isInteger(band.endMinute)
      || Number(band.startMinute) < 0 || Number(band.endMinute) > 1440 || Number(band.startMinute) >= Number(band.endMinute)) throw new Error('開始より後の終了時刻を設定してください。日をまたぐ時間帯は日ごとに分けてください。');
    return { weekday: band.weekday, startMinute: Number(band.startMinute), endMinute: Number(band.endMinute) };
  }).sort((a, b) => a.weekday - b.weekday || a.startMinute - b.startMinute || a.endMinute - b.endMinute);
  const merged: PrivateAllowedBand[] = [];
  for (const band of bands) {
    const prior = merged.at(-1);
    if (prior && prior.weekday === band.weekday && band.startMinute <= prior.endMinute) prior.endMinute = Math.max(prior.endMinute, band.endMinute);
    else merged.push({ ...band });
  }
  return { timeZone: value.timeZone, restDays: [...new Set(value.restDays)].sort((a, b) => a - b),
    loadLimits: { heavyDailyLimit: Number(value.loadLimits.heavyDailyLimit), normalDailyLimit: Number(value.loadLimits.normalDailyLimit) }, allowedBands: merged };
}

export function snapshotSavedPrivatePlannerPreferences(value: SavedPrivatePlannerPreferences, ownerUserId: string): SavedPrivatePlannerPreferences {
  assertSharedIdentifier(ownerUserId);
  if (!fields(value, ['schemaVersion', 'ownerUserId', 'revision', 'timeZone', 'restDays', 'loadLimits', 'allowedBands'])
    || value.schemaVersion !== 1 || value.ownerUserId !== ownerUserId || !Number.isSafeInteger(value.revision) || value.revision < 1) throw new Error('本人の保存済み設定を確認できません。');
  return { schemaVersion: 1, ownerUserId, revision: value.revision,
    ...snapshotPrivatePlannerPreferences({ timeZone: value.timeZone, restDays: value.restDays, loadLimits: value.loadLimits, allowedBands: value.allowedBands }) };
}

/** Empty means no permission. Gap/fold boundaries remain unresolved instead of choosing an instant. */
export function privatePlannerAllowedWindows(value: PrivatePlannerPreferences, from: LocalDate, through: LocalDate): {
  windows: InstantRange[]; unresolvedDates: LocalDate[];
} {
  const own = snapshotPrivatePlannerPreferences(value); parseLocalDate(from); parseLocalDate(through);
  if (from > through || daysBetween(from, through) > 366) throw new Error('時間帯を確認する期間を確認してください。');
  const windows: InstantRange[] = []; const unresolvedDates: LocalDate[] = [];
  for (let date = from; date <= through; date = addDays(date, 1)) {
    const day = weekdayOf(date); const selected = own.allowedBands.filter(band => band.weekday === day); const daily: InstantRange[] = [];
    let unresolved = false;
    for (const band of selected) {
      const at = (minute: number) => v2WallTimeCandidates({ date: minute === 1440 ? addDays(date, 1) : date,
        hour: minute === 1440 ? 0 : Math.floor(minute / 60), minute: minute % 60, timeZone: own.timeZone });
      const start = at(band.startMinute); const end = at(band.endMinute);
      if (start.length !== 1 || end.length !== 1 || start[0] >= end[0]) { unresolved = true; break; }
      daily.push({ start: start[0], end: end[0] });
    }
    if (unresolved) unresolvedDates.push(date); else windows.push(...daily);
  }
  return { windows: mergeInstantRanges(windows), unresolvedDates };
}
