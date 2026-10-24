import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
} from '@/domain/chores/types';
import type { EntityId, LocalDate } from '@/domain/shared/types';

export interface ScheduleGenerationInput {
  householdId: EntityId;
  from: LocalDate;
  through: LocalDate;
  chores: readonly ChoreDefinition[];
  dependencies: readonly ChoreDependency[];
  completions: readonly ChoreCompletion[];
}

export interface ScheduleEngine {
  generate(input: ScheduleGenerationInput): Promise<ChoreScheduleEntry[]>;
  rescheduleIncomplete(
    input: ScheduleGenerationInput & { incompleteEntryIds: readonly EntityId[] },
  ): Promise<ChoreScheduleEntry[]>;
}
