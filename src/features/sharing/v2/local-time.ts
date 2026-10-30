import moment from 'moment-timezone';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';

const offsetsByZone = new WeakMap<object, { source: readonly number[]; values: readonly number[] }>();

/** Exact instants for one pinned civil clock. A gap has none; a fold has multiple, never a guessed winner. */
export function v2WallTimeCandidates(input: { date: LocalDate; hour: number; minute: number; timeZone: string; second?: number; millisecond?: number }): number[] {
  const second = input.second ?? 0; const millisecond = input.millisecond ?? 0;
  if (![[input.hour, 23], [input.minute, 59], [second, 59], [millisecond, 999]].every(([value, max]) => Number.isInteger(value) && value >= 0 && value <= max)) throw new Error('Invalid shared wall clock');
  const zone = moment.tz.zone(input.timeZone); if (!zone) throw new Error('Unsupported shared timezone');
  let known = offsetsByZone.get(zone);
  if (!known || known.source !== zone.offsets) { known = { source: zone.offsets, values: [...new Set(zone.offsets)] }; offsetsByZone.set(zone, known); }
  const wall = parseLocalDate(input.date).getTime() + (input.hour * 3600 + input.minute * 60 + second) * 1000 + millisecond;
  return [...new Set(known.values.map((offset) => Math.round(wall + offset * 60_000)))]
    .filter((at) => Number.isFinite(at) && Math.round(at - zone.utcOffset(at) * 60_000) === wall).sort((a, b) => a - b);
}
