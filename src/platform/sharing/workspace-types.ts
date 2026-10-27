import type { SQLiteDatabase } from 'expo-sqlite';
import type { createSharingCloud } from './firestore-cloud';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto';
import type { createSharedGroupManager } from '../../features/sharing/group-manager';
import type { SharingSyncResult } from '../../features/sharing/synchronizer';
import type { VerifiedSharedRoster } from '../../features/sharing/roster';
import type { SharingSelection } from '../../features/sharing/workspace-selection';
import type { SharingWorkspaceRecord } from '../storage/sharing-registry';
import type { readSharingCheckpoint } from '../storage/sharing-ledger';
import type { createSharedPlannerRepository } from '../storage/shared-planner-repository';
import type { SharedEntityType } from '../../features/sharing/operations';
import type { V2WorkspaceSession } from '../../features/sharing/v2/workspace-session';

export interface SharedWorkspaceOverview {
  timeZone: string; members: { id: string; displayName: string }[]; chores: { id: string; name: string }[]; hasConflicts: boolean;
}
interface SharedWorkspaceBase extends SharingSelection {
  cloud: ReturnType<typeof createSharingCloud>; identity: DeviceSecretIdentity;
  record: () => Promise<SharingWorkspaceRecord>; roster: () => VerifiedSharedRoster | undefined;
  sync: (options?: { force?: boolean; budgetMs?: number }) => Promise<SharingSyncResult>;
  checkpoint: () => ReturnType<typeof readSharingCheckpoint>;
  watch: (callback: () => void, failed: (error: unknown) => void) => () => void;
  cancelJoinRequest: () => Promise<void>; maintainHistory: () => Promise<void>;
  readOverview: () => Promise<SharedWorkspaceOverview>; drain: () => Promise<void>;
}
export interface LegacySharedWorkspace extends SharedWorkspaceBase {
  protocol: 1; database: SQLiteDatabase; adapter: ReturnType<typeof createSharedPlannerRepository>;
  manager: ReturnType<typeof createSharedGroupManager>;
  resolveConflict: (entityType: SharedEntityType, entityId: string, field: string, candidateId: string) => Promise<void>;
}
export interface V2SharedWorkspace extends SharedWorkspaceBase {
  protocol: 2; database: SQLiteDatabase; session: V2WorkspaceSession;
  manager: ReturnType<typeof createSharedGroupManager>;
}
export interface PendingSharedWorkspace extends SharedWorkspaceBase {
  protocol: null; database: null; manager: null;
}
export type SharedWorkspace = LegacySharedWorkspace | V2SharedWorkspace | PendingSharedWorkspace;
