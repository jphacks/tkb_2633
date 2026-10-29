import type { SQLiteDatabase } from 'expo-sqlite';
import type { PlannerSnapshot } from './repository.ts';

export type SharedRepositoryMutation = 'completeFirstSetup' | 'updatePlannerSettings' | 'updateChoreDefinition'
  | 'updateChoreSettings' | 'saveReviewedApplianceCare' | 'setChoreEnabled' | 'setChoresEnabled' | 'completeChore'
  | 'importGoogleTaskCompletions' | 'importGoogleTaskChanges' | 'undoCompletedChore' | 'recordIncompleteChore'
  | 'setChoreAssignments' | 'addHouseholdMember' | 'replaceChoreDependencies' | 'saveWeeklyWasteSchedule'
  | 'setWasteOccurrenceHidden' | 'deleteWeeklyWasteSchedule' | 'setCalendarAvailabilityEnabled';
export interface SharedRepositoryAdapter {
  groupId: string;
  userId: string;
  readSnapshot(now: Date): Promise<PlannerSnapshot>;
  mutate(kind: SharedRepositoryMutation, args: readonly unknown[]): Promise<unknown>;
}
const adapters = new WeakMap<SQLiteDatabase, SharedRepositoryAdapter>();

/** A scope belongs to a DB connection, never to a process-wide mutable household ID. */
export function registerSharedRepositoryAdapter(database: SQLiteDatabase, adapter: SharedRepositoryAdapter): () => void {
  const existing = adapters.get(database);
  if (existing && (existing.groupId !== adapter.groupId || existing.userId !== adapter.userId)) throw new Error('Database already belongs to another workspace');
  adapters.set(database, adapter);
  return () => { if (adapters.get(database) === adapter) adapters.delete(database); };
}
export function sharedRepositoryAdapter(database: SQLiteDatabase): SharedRepositoryAdapter | undefined { return adapters.get(database); }
