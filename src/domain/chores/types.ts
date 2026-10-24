import type { EntityId, ISODateTime, LocalDate, WeatherLocation } from '@/domain/shared/types';

export type ChoreLoad = 'light' | 'normal' | 'heavy';
export type FrequencyMode = 'frequent' | 'balanced' | 'relaxed';
export type LaundryDryingPreference = 'indoors' | 'outdoors' | 'either';
export type ChoreStatus = 'initialPending' | 'scheduled' | 'inWindow' | 'overdue';

export interface ChoreSourceEvidence {
  url: string;
  pageOrSection?: string;
}

export interface ApplianceCareSource {
  manufacturer: string;
  productName: string;
  modelNumber: string;
  productUrl?: string;
  manualUrl: string;
  analyzedAt: ISODateTime;
  evidence: ChoreSourceEvidence[];
}

export interface ChoreDefinition {
  id: EntityId;
  householdId: EntityId;
  name: string;
  category: string;
  description: string;
  enabled: boolean;
  /** User override. When unset, the selected frequency mode supplies the cycle. */
  recommendedCycleDays?: number;
  /** User override for an appliance-care task. Kept separate from the maker interval. */
  userIntervalDays?: number;
  /** Manufacturer-stated starting interval. User edits are stored separately above. */
  manufacturerRecommendedIntervalDays?: number;
  /** Conditions stated by the manufacturer when no fixed cycle is specified. */
  manufacturerRecommendedConditions?: string[];
  /** True when the manufacturer gave no interval and the user has not selected one. */
  requiresCycleSelection?: boolean;
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
  /** Provenance for appliance-care chores created from a reviewed official manual analysis. */
  applianceCareSource?: ApplianceCareSource;
  /** Stable parent appliance id. */
  applianceId?: EntityId;
  /** Exact maintenance task name from the reviewed manufacturer analysis. */
  applianceTaskName?: string;
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
  /** The date this occurrence was scheduled for, kept even if completion regenerates the schedule. */
  scheduledDate?: LocalDate;
  scheduledWindowStart?: LocalDate;
  scheduledWindowEnd?: LocalDate;
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
  notificationsEnabled: boolean;
  setupCompleted: boolean;
  /** Region selected from user-entered text for weather forecasts. */
  weatherLocation?: WeatherLocation;
}
