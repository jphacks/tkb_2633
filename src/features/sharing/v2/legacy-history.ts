import type { VerifiedLegacyMigration } from './legacy-migration-source.ts';
import { readVerifiedLegacyMigrationSource } from './legacy-migration-source.ts';
export interface LegacyCompletionRecord {
  operationId: string; choreId: string; choreName: string; performedAt: string;
  performerUserId: string | null; recorderUserId: string; active: boolean; outcome: string;
}
/** Presentation of original reports; never invent a v2 round, assignee, receipt time or performer. */
export function legacyCompletionHistory(checkpoint: VerifiedLegacyMigration): LegacyCompletionRecord[] {
  const { replica } = readVerifiedLegacyMigrationSource(checkpoint);
  const undos = new Set(replica.operations.filter(op => op.entityType === 'completion' && op.operationType === 'undo').map(op => op.payload.targetOperationId));
  const names = new Map(replica.entities.filter(entity => entity.entityType === 'chore').map(entity => [entity.entityId, entity.fields.name]));
  return replica.operations.filter(op => op.entityType === 'completion' && op.operationType === 'complete').map(op => ({
    operationId: op.operationId, choreId: op.payload.choreId as string,
    choreName: typeof names.get(op.payload.choreId as string) === 'string' ? names.get(op.payload.choreId as string) as string : '移行前の家事',
    performedAt: op.payload.completedAt as string, performerUserId: typeof op.payload.completedByMemberId === 'string' ? op.payload.completedByMemberId : null,
    recorderUserId: op.authorUserId, active: !undos.has(op.operationId), outcome: op.payload.outcome as string,
  })).sort((a, b) => a.performedAt.localeCompare(b.performedAt) || a.operationId.localeCompare(b.operationId));
}
