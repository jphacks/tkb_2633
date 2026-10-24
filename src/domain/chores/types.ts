import type { EntityId, GeoCoordinates, ISODateTime, LocalDate } from '@/domain/shared/types';

export type ChoreLoad = 'light' | 'normal' | 'heavy';
export type FrequencyMode = 'frequent' | 'balanced' | 'relaxed';
export type LaundryDryingPreference = 'indoors' | 'outdoors' | 'either';
export type ChoreStatus = 'initialPending' | 'scheduled' | 'inWindow' | 'overdue';

export interface ChoreDefinition {
  id: EntityId;
  householdId: EntityId;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  /** User override. When unset, the selected frequency mode supplies the cycle. */
  recommendedCycleDays?: number;
  frequencyDaysByMode: Record<FrequencyMode, number>;
  /** Radius around the target date; 1 means target ±1 day. */
  windowRadiusDays: number;
  /** Maximum movement from the cycle date when holidays or load require it. */
  maxShiftDays: number;
  load: ChoreLoad;
  holidayPriority: boolean;
  everyday: boolean;
  locationOrAppliance?: string;
  laundryDryingPreference?: LaundryDryingPreference;
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
  cycleBaseDate: LocalDate;
  windowStart: LocalDate;
  windowEnd: LocalDate;
  suggestedDate: LocalDate;
  status: ChoreStatus;
  assignedMemberIds: EntityId[];
  overdueDays?: number;
  overdueCycles?: number;
}

export interface ChoreCompletion {
  id: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  completedAt: ISODateTime;
  completedByMemberId?: EntityId;
  outcome: 'completed' | 'incomplete';
  source?: 'inApp' | 'notification' | 'widget';
  scheduleEntryId?: EntityId;
  completionNote?: 'completedNow' | 'alreadyDone';
  estimatedDate?: boolean;
}

export interface ChoreState {
  choreId: EntityId;
  lastCompletedDate?: LocalDate;
  lastCompletedEstimated: boolean;
  initialPending: boolean;
  initialScheduledDate?: LocalDate;
  unknownReason?: 'unknown' | 'skipped';
}

export interface HouseholdPlannerSettings {
  householdId: EntityId;
  frequencyMode: FrequencyMode;
  restDays: number[];
  heavyDailyLimit: number;
  normalDailyLimit: number;
  notificationHour: number;
  notificationMinute: number;
  setupCompleted: boolean;
  /** Approximate, user-approved device location used only for weather forecasts. */
  weatherLocation?: GeoCoordinates;
}
