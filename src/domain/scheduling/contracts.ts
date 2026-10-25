import type {
  ChoreState,
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
  FrequencyMode,
} from '@/domain/chores/types';
import type { EntityId, LocalDate, Weekday } from '@/domain/shared/types';

export interface ScheduleLoadLimits {
  heavyDailyLimit: number;
  normalDailyLimit: number;
}

export interface ScheduleSettings {
  frequencyMode: FrequencyMode;
  restDays: readonly Weekday[];
  loadLimits: ScheduleLoadLimits;
}

export interface ScheduleGenerationInput {
  householdId: EntityId;
  from: LocalDate;
  through: LocalDate;
  today: LocalDate;
  chores: readonly ChoreDefinition[];
  states: readonly ChoreState[];
  assignments: readonly { choreId: EntityId; memberIds: readonly EntityId[] }[];
  dependencies: readonly ChoreDependency[];
  completions: readonly ChoreCompletion[];
  /** Previously generated entries preserve a cycle's selected recommendation across refreshes. */
  previousScheduleEntries?: readonly ChoreScheduleEntry[];
  settings: ScheduleSettings;
}

export interface ScheduleEngine {
  generate(input: ScheduleGenerationInput): Promise<ChoreScheduleEntry[]>;
  rescheduleIncomplete(
    input: ScheduleGenerationInput & { incompleteEntryIds: readonly EntityId[] },
  ): Promise<ChoreScheduleEntry[]>;
}
