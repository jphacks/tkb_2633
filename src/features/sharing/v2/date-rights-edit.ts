import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations';
import type { V2HistoryView } from './history-view';
import type { V2EditableField, V2FieldEdit } from './field-edit';
import { editableValueFromOperations } from './field-edit.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';
import { v2DatePermissionId } from './occurrence-id.ts';

export interface V2DateRightsValue { enabled: boolean; rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean } }
export type V2DateRightsEdit = Omit<V2FieldEdit, 'field'> & { userId: string; expectedMembershipStart: number };
const sourceValue = (operation: SharedOperation): JsonValue => ({ enabled: operation.payload.enabled, rights: operation.payload.rights });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);
const sourceIds = (field: V2EditableField) => field.candidates.map(candidate => candidate.operationId).sort();
const value = (field: V2EditableField) => field.kind === 'value' ? field.value : null;

export function readV2DateRights(view: V2HistoryView, at: SharedOperation, choreId: string, userId: string, membershipStart: number) {
  return editableDateRightsFromOperations(view.observed(view.topic('datePermission', v2DatePermissionId(view.groupId, choreId, userId)), at)
    .filter(operation => operation.keyVersion >= membershipStart));
}
export const editableDateRightsFromOperations = (operations: readonly SharedOperation[]) => editableValueFromOperations(operations, sourceValue);

/** Never combine the enabled bit from one concurrent grant with the rights from another. */
export function prepareV2DateRightsEdit(input: { view: V2HistoryView; at: SharedOperation; choreId: string; edit: V2DateRightsEdit; membershipStart: number }) {
  const { view, at, choreId, edit } = input; const entityId = v2DatePermissionId(view.groupId, choreId, edit.userId);
  if (edit.expectedMembershipStart !== input.membershipStart) throw new V2StaleSettingsError();
  if (edit.basisOperationIds.length > 256 || new Set(edit.basisOperationIds).size !== edit.basisOperationIds.length) throw new V2StaleSettingsError();
  const operations = edit.basisOperationIds.map(id => {
    const operation = view.byId(id);
    if (!operation || operation.entityType !== 'datePermission' || operation.entityId !== entityId || operation.keyVersion < input.membershipStart
      || view.observed([operation], at).length !== 1) throw new V2StaleSettingsError();
    return operation;
  });
  const base = editableValueFromOperations(operations, sourceValue); const current = readV2DateRights(view, at, choreId, edit.userId, input.membershipStart);
  if (!same(sourceIds(base), [...edit.basisOperationIds].sort())) throw new V2StaleSettingsError();
  if (edit.resolveOperationIds !== undefined) {
    if (current.kind !== 'conflict' || new Set(edit.resolveOperationIds).size !== edit.resolveOperationIds.length
      || !same(sourceIds(current), [...edit.resolveOperationIds].sort())) throw new V2StaleSettingsError();
  } else if (base.kind === 'conflict' || current.kind === 'conflict' || !same(value(base), value(current)) && !same(value(current), edit.value)) throw new V2StaleSettingsError();
  const next = edit.value;
  if (!next || typeof next !== 'object' || Array.isArray(next) || !same(Object.keys(next).sort(), ['enabled', 'rights'])) throw new Error('変更する権限を確認してください。');
  return { entityId, current, changed: current.kind !== 'value' || !same(current.value, next),
    payload: { choreId, userId: edit.userId, enabled: next.enabled, rights: next.rights } };
}
