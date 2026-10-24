import type { EntityId, ISODateTime, LocalDate } from '@/domain/shared/types';

export type ChoreLoad = 'light' | 'normal' | 'heavy';
export type ChoreStatus = 'initialPending' | 'scheduled' | 'inWindow' | 'overdue' | 'completed';

export interface ChoreDefinition {
  id: EntityId;
  householdId: EntityId;
  name: string;
  enabled: boolean;
  recommendedCycleDays?: number;
  windowWidthDays?: number;
  load: ChoreLoad;
  instructions: string[];
  tools: string[];
  cautions: string[];
  estimatedMinutes?: number;
}

export interface ChoreAssignment {
  choreId: EntityId;
  memberIds: EntityId[];
}

/** A dependency link; ordering and conflict behavior are supplied by a policy later. */
export interface ChoreDependency {
  id: EntityId;
  predecessorChoreId: EntityId;
  successorChoreId: EntityId;
  policyData?: unknown;
}

export interface ChoreScheduleEntry {
  id: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  windowStart: LocalDate;
  windowEnd: LocalDate;
  suggestedDate: LocalDate;
  status: ChoreStatus;
  assignedMemberIds: EntityId[];
}

export interface ChoreCompletion {
  id: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  completedAt: ISODateTime;
  completedByMemberId?: EntityId;
  source?: 'inApp' | 'notification' | 'widget';
}
