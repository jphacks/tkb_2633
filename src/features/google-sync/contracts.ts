import type { ChoreScheduleEntry } from '@/domain/chores/types';
import type { EntityId, ISODateTime, LocalDate } from '@/domain/shared/types';
import type { GoogleSyncStatus } from './sync-policy';

export interface GoogleSyncState {
  householdId: EntityId;
  enabled: boolean;
  taskListId?: string;
  /** Device-local Google subject; never a shared group field or Firebase user ID. */
  accountSubject?: string;
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
  /** The last acknowledged state of this exact mapped task. */
  lastSyncedStatus?: GoogleTaskStatus;
  /** Durable local intent; it is cleared only after this revision reaches Google. */
  pendingStatus?: GoogleTaskStatus;
  pendingStatusRevision?: string;
  createdAt: ISODateTime;
  updatedAt: ISODateTime;
}

export type GoogleTaskStatus = 'needsAction' | 'completed';

export type GoogleTaskStatusChange = Pick<GoogleTaskLink, 'googleTaskListId' | 'googleTaskId' | 'scheduleEntryId'> & (
  | { status: 'completed'; completedAt: ISODateTime }
  | { status: 'needsAction' }
);

export interface GoogleSyncEntry {
  entry: ChoreScheduleEntry;
  choreName: string;
  completedAt?: ISODateTime;
  /** A legacy/local incomplete record, needed when no status baseline has been acknowledged yet. */
  locallyIncomplete?: boolean;
}

export interface GoogleTaskCompletion {
  googleTaskListId: string;
  googleTaskId: string;
  scheduleEntryId: EntityId;
  completedAt: ISODateTime;
}
