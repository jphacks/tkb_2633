import { normalizeWasteSchedule, wasteCollectionRule } from '../../waste/schedule-policy.ts';
import { generateWasteCollectionDates } from '../../waste/weekly-scheduler.ts';
import type { WasteScheduleInput } from '../../waste/contracts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger';
import { v2ReadPoint } from './view-point.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';
import { prepareV2WasteEdits, readV2Waste, readV2WasteVisibility, v2WasteVisibilityId } from './waste-state.ts';
import type { V2WasteEdit, V2WasteSelection } from './waste-state';

export function createV2WasteActions(repository: ReturnType<typeof createV2EventRepository>, makeId: () => string) {
  const draft = (entityType: 'waste' | 'wasteVisibility', entityId: string, payload: SharedOperationDraft['payload'], operationType: 'patch' | 'delete' | 'restore' = 'patch'): SharedOperationDraft =>
    ({ operationId: makeId(), entityType, entityId, payload, operationType });
  return {
    addWasteSchedule: (input: WasteScheduleInput) => {
      const value = normalizeWasteSchedule(input); const id = makeId();
      return repository.commit([draft('waste', id, { label: value.label, ...wasteCollectionRule(value) })]);
    },
    editWasteSchedule: (id: string, edits: readonly V2WasteEdit[]) => repository.commitCurrent(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
      const patch = prepareV2WasteEdits(state.assessment.view, at, id, edits);
      return Object.keys(patch).length ? [draft('waste', id, patch)] : [];
    }),
    deleteWasteSchedule: (id: string, expectedRevision: string) => repository.commitCurrent(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!); const current = readV2Waste(state.assessment.view, at, id);
      if (current.row.deleted) return [];
      if (current.alive.kind === 'missing' || current.row.revision !== expectedRevision) throw new V2StaleSettingsError();
      return [draft('waste', id, {}, 'delete')];
    }),
    resolveWastePresence: (id: string, expectedRevision: string, keep: boolean, reviewed?: WasteScheduleInput) => repository.commitCurrent(async state => {
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!); const current = readV2Waste(state.assessment.view, at, id);
      if (typeof keep !== 'boolean' || current.alive.kind !== 'conflict' || current.row.revision !== expectedRevision) throw new V2StaleSettingsError();
      if (!keep) return [draft('waste', id, {}, 'delete')];
      if (!reviewed) throw new Error('残す収集日の名前とルールを確認してください。');
      const value = normalizeWasteSchedule(reviewed);
      return [draft('waste', id, { label: value.label, ...wasteCollectionRule(value) }, 'restore')];
    }),
    setWasteOccurrenceHidden: (selection: V2WasteSelection, hidden: boolean, resolveConflict = false) => repository.commitCurrent(async state => {
      if (selection.groupId !== repository.scope.groupId || typeof hidden !== 'boolean') throw new V2StaleSettingsError();
      const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!); const view = state.assessment.view;
      const current = readV2Waste(view, at, selection.scheduleId);
      if (!current.row.schedule || current.row.revision !== selection.scheduleRevision
        || generateWasteCollectionDates(current.row.schedule, selection.date, selection.date).length !== 1) throw new V2StaleSettingsError();
      const visibility = readV2WasteVisibility(view, at, selection.scheduleId, selection.date);
      if (visibility.hidden === hidden) return [];
      if (visibility.revision !== selection.visibilityRevision || visibility.hidden === null && !resolveConflict) throw new V2StaleSettingsError();
      return [draft('wasteVisibility', v2WasteVisibilityId(selection.scheduleId, selection.date), { scheduleId: selection.scheduleId, date: selection.date, hidden })];
    }),
  };
}
