import type { EntityId, LocalDate, Weekday } from '@/domain/shared/types';

export interface WeeklyWasteSchedule {
  id: EntityId;
  householdId: EntityId;
  label: string;
  collectionWeekdays: readonly Weekday[];
}

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
