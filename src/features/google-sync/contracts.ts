import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { EntityId, ISODateTime, LocalDate } from '@/domain/shared/types';
import type { GoogleSyncStatus } from './sync-policy';

export interface GoogleSyncState {
  householdId: EntityId;
  enabled: boolean;
  taskListId?: string;
  lastAttemptAt?: ISODateTime;
  lastSuccessfulSyncAt?: ISODateTime;
  status: GoogleSyncStatus;
  retryCount: number;
  nextRetryAt?: ISODateTime;
  lastErrorCode?: string;
  lastErrorAt?: ISODateTime;
  updatedAt: ISODateTime;
}

export interface GoogleTaskLink {
  scheduleEntryId: EntityId;
  householdId: EntityId;
  choreId: EntityId;
  googleTaskListId: string;
  googleTaskId: string;
  lastSyncedTitle?: string;
  lastSyncedDueDate?: LocalDate;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export interface GoogleSyncEntry {
  entry: ChoreScheduleEntry;
  choreName: string;
  completedAt?: ISODateTime;
}

export interface GoogleTaskCompletion {
  googleTaskListId: string;
  googleTaskId: string;
  scheduleEntryId: EntityId;
  completedAt: ISODateTime;
}
