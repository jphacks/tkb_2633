import type { EntityId, LocalDate, Weekday } from '@/domain/shared/types';

export interface WeeklyWasteSchedule {
  id: EntityId;
  householdId: EntityId;
  label: string;
  collectionWeekdays: readonly Weekday[];
  /** Older records without a recurrence continue to mean every week. */
  recurrence?: WasteRecurrence;
  anchorDate?: LocalDate;
  /** If the month is shorter, collection is on the last day of that month. */
  monthlyDay?: number;
}

export type WasteRecurrence = 'weekly' | 'biweekly' | 'monthly';

export type WasteScheduleInput = Omit<WeeklyWasteSchedule, 'id' | 'householdId'> & { id?: EntityId };

export interface WasteCollectionOccurrence {
  scheduleId: EntityId;
  householdId: EntityId;
  label: string;
  date: LocalDate;
}

export interface WasteScheduleRange {
  from: LocalDate;
  through: LocalDate;
}

export interface WasteExceptionSource<TException = unknown> {
  list(scheduleId: EntityId, range: WasteScheduleRange): Promise<readonly TException[]>;
}

/** Future holiday/rescheduling policy. One-time manual hiding already uses occurrence-visibility.ts. */
export interface WasteExceptionPolicy<TException = unknown> {
  apply(
    weeklyOccurrences: readonly WasteCollectionOccurrence[],
    exceptions: readonly TException[],
  ): readonly WasteCollectionOccurrence[];
}
