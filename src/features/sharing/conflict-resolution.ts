import type { SharedEntityType } from './operations.ts';
import type { SharedReplica } from './replica.ts';
import type { SharedOperationDraft } from '../../platform/storage/sharing-ledger.ts';
import type { WasteScheduleInput } from '../waste/contracts.ts';
import { wasteCollectionRule } from '../waste/schedule-policy.ts';

const ruleFields = ['recurrence', 'collectionWeekdays', 'anchorDate', 'monthlyDay'];

/** Preserve the complete rule of the chosen edit, rather than mixing incompatible field candidates. */
export function planSharedConflictResolution(replica: SharedReplica, entityType: SharedEntityType, entityId: string,
  field: string, candidateId: string, operationId: string): SharedOperationDraft {
  const entity = replica.entities.find((item) => item.entityType === entityType && item.entityId === entityId);
  const candidate = entity?.conflicts[field]?.find((item) => item.operationId === candidateId);
  if (!entity || !candidate) throw new Error('競合の内容が更新されました。もう一度選び直してください。');
  const restored = Object.fromEntries(Object.entries(entity.fields).filter(([, value]) => value !== null));
  let payload = field === '$alive' ? candidate.value ? restored : {} : { [field]: candidate.value };
  if (entityType === 'waste' && ruleFields.includes(field)) {
    const source = replica.operations.find((operation) => operation.operationId === candidateId);
    // Older operations without the complete rule retain their existing field resolution behavior.
    if (source && ruleFields.every((key) => Object.hasOwn(source.payload, key))) {
      payload = wasteCollectionRule({ ...source.payload, label: '収集日' } as unknown as WasteScheduleInput);
    }
  }
  return { operationId, entityType, entityId,
    operationType: field === '$alive' ? candidate.value ? 'restore' : 'delete' : 'patch', payload };
}
