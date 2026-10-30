import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations';
import type { V2HistoryView } from './history-view';
import type { V2FieldEdit } from './field-edit';
import { compareV2ValueEdit, editableValueFromOperations, readV2EditBasis } from './field-edit.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';
import { v2DatePermissionId } from './occurrence-id.ts';

export interface V2DateRightsValue { enabled: boolean; rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean } }
export type V2DateRightsEdit = Omit<V2FieldEdit, 'field'> & { userId: string; expectedMembershipStart: number };
const sourceValue = (operation: SharedOperation): JsonValue => ({ enabled: operation.payload.enabled, rights: operation.payload.rights });
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

export function readV2DateRights(view: V2HistoryView, at: SharedOperation, choreId: string, userId: string, membershipStart: number) {
  return editableDateRightsFromOperations(view.observed(view.topic('datePermission', v2DatePermissionId(view.groupId, choreId, userId)), at)
    .filter(operation => operation.keyVersion >= membershipStart));
}
export const editableDateRightsFromOperations = (operations: readonly SharedOperation[]) => editableValueFromOperations(operations, sourceValue);

/** Never combine the enabled bit from one concurrent grant with the rights from another. */
export function prepareV2DateRightsEdit(input: { view: V2HistoryView; at: SharedOperation; choreId: string; edit: V2DateRightsEdit; membershipStart: number }) {
  const { view, at, choreId, edit } = input; const entityId = v2DatePermissionId(view.groupId, choreId, edit.userId);
  if (edit.expectedMembershipStart !== input.membershipStart) throw new V2StaleSettingsError();
  const base = readV2EditBasis({ view, at, type: 'datePermission', entityId, operationIds: edit.basisOperationIds,
    accepts: operation => operation.keyVersion >= input.membershipStart, readValue: sourceValue });
  const current = readV2DateRights(view, at, choreId, edit.userId, input.membershipStart);
  const next = edit.value;
  if (!next || typeof next !== 'object' || Array.isArray(next) || !same(Object.keys(next).sort(), ['enabled', 'rights'])) throw new Error('変更する権限を確認してください。');
  return { entityId, current, changed: compareV2ValueEdit(current, base, edit),
    payload: { choreId, userId: edit.userId, enabled: next.enabled, rights: next.rights } };
}
