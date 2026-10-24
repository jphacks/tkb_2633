import type { EntityId, ISODateTime } from '@/domain/shared/types';

export interface PendingHouseholdChange {
  id: EntityId;
  changeType: string;
  payload: unknown;
  createdAt: ISODateTime;
}

/** Local outbox boundary for future household synchronization; no server is chosen. */
export interface HouseholdSyncGateway {
  enqueue(change: PendingHouseholdChange): Promise<void>;
  synchronize(): Promise<void>;
}
