import type { ChoreDefinition } from '@/domain/chores/types';

export const CALENDAR_BUSY_BUCKET_LIMITS = [120, 300, 480] as const;
export const CALENDAR_BUSY_SHIFT_EQUIVALENT = { light: 1, normal: 2, heavy: 3 } as const;

export function busyMinutesToBucket(minutes = 0): number {
  if (!Number.isFinite(minutes) || minutes < 0) return 0;
  return CALENDAR_BUSY_BUCKET_LIMITS.filter((limit) => minutes > limit).length;
}

export function calendarPenaltyForChore(load: ChoreDefinition['load'], busyMinutes?: number): number {
  return busyMinutesToBucket(busyMinutes) * CALENDAR_BUSY_SHIFT_EQUIVALENT[load];
}
