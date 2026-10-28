import { canonicalJson, compareOperationIds } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations';
import { sharedDocumentDigest } from '../crypto.ts';
import type { LocalDate } from '../../../domain/shared/types';
import type { WasteCollectionOccurrence, WasteScheduleInput, WeeklyWasteSchedule } from '../../waste/contracts';
import { normalizeWasteSchedule, wasteCollectionRule } from '../../waste/schedule-policy.ts';
import { generateWasteCollectionDates } from '../../waste/weekly-scheduler.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { V2HistoryView } from './history-view';
import type { V2EditableField, V2FieldEdit } from './field-edit';
import { compareV2ValueEdit, editableValueFromOperations, readV2EditBasis, readV2EditableField } from './field-edit.ts';
import { V2StaleSettingsError } from './configuration-edit.ts';

export const V2_WASTE_RULE_FIELDS = ['recurrence', 'collectionWeekdays', 'anchorDate', 'monthlyDay'] as const;
export type V2WasteEdit = V2FieldEdit & { field: 'label' | 'rule' };
export interface V2WasteField { kind: V2EditableField['kind']; value: JsonValue | undefined;
  candidates: { operationId: string; authorUserId: string; recordedAt: string | null; value: JsonValue }[] }
export interface V2WasteRow { id: string; label: string; deleted: boolean; needsReview: boolean; revision: string; schedule: WeeklyWasteSchedule | null;
  fields: { label: V2WasteField; rule: V2WasteField; presence: V2WasteField } }
export interface V2WasteSelection { groupId: string; scheduleId: string; date: LocalDate; scheduleRevision: string; visibilityRevision: string }
export interface V2WasteOccurrence { key: string; occurrence: WasteCollectionOccurrence; hidden: boolean | null; selection: V2WasteSelection }
export const v2WasteVisibilityId = (id: string, date: LocalDate) => `visibility.${sharedDocumentDigest([id, date])}`;
const ids = (field: V2EditableField) => field.candidates.map(candidate => candidate.operationId);
const value = (field: V2EditableField) => field.kind === 'value' ? field.value : undefined;
const compact = (field: V2EditableField): V2WasteField => ({ kind: field.kind, value: value(field), candidates: field.candidates.map(candidate => ({
  operationId: candidate.operationId, authorUserId: candidate.authorUserId, recordedAt: candidate.recordedAt, value: candidate.value,
})) });
const touchesRule = (operation: SharedOperation) => V2_WASTE_RULE_FIELDS.some(field => Object.hasOwn(operation.payload, field));

/** A legacy partial edit is read at its own causal cut; concurrent rule parts are never combined. */
export function v2WasteRuleAt(view: V2HistoryView, source: SharedOperation): JsonValue {
  try {
    const cut = { ...source, context: { ...source.context, [source.authorDeviceId]: source.deviceSequence } };
    const raw = V2_WASTE_RULE_FIELDS.every(field => Object.hasOwn(source.payload, field)) ? source.payload
      : Object.fromEntries(V2_WASTE_RULE_FIELDS.map(field => {
        const current = readV2EditableField(view, cut, 'waste', source.entityId, field);
        if (current.kind === 'conflict') throw new Error('Unresolved original rule'); return [field, value(current)];
      }));
    return JSON.parse(canonicalJson(wasteCollectionRule({ ...raw, label: '収集日' } as unknown as WasteScheduleInput)));
  } catch { return null; }
}

export function readV2Waste(view: V2HistoryView, at: SharedOperation, id: string) {
  const alive = readV2EditableField(view, at, 'waste', id, '$alive');
  const label = readV2EditableField(view, at, 'waste', id, 'label');
  const rule = editableValueFromOperations(view.observed(view.topic('waste', id), at).filter(touchesRule), source => v2WasteRuleAt(view, source));
  let schedule: WeeklyWasteSchedule | null = null;
  if (alive.kind === 'value' && alive.value === true && label.kind === 'value' && rule.kind === 'value' && rule.value) try {
    schedule = { ...normalizeWasteSchedule({ ...rule.value as object, label: label.value } as WasteScheduleInput), id, householdId: `shared:${view.groupId}` };
  } catch { /* Keep invalid or conflicting records available for explicit repair. */ }
  const row: V2WasteRow = { id, label: typeof value(label) === 'string' ? value(label) as string : '収集日の名前を確認',
    deleted: alive.kind === 'value' && alive.value === false, needsReview: !schedule,
    revision: sharedDocumentDigest([view.groupId, id, ids(alive), ids(label), ids(rule)]), schedule, fields: { label: compact(label), rule: compact(rule), presence: compact(alive) } };
  return { row, alive, fields: { label, rule } };
}

export function prepareV2WasteEdits(view: V2HistoryView, at: SharedOperation, id: string, edits: readonly V2WasteEdit[]) {
  const current = readV2Waste(view, at, id); const patch: Record<string, JsonValue> = {}; const seen = new Set<string>();
  if (current.alive.kind !== 'value' || current.alive.value !== true) throw new V2StaleSettingsError();
  for (const edit of edits) {
    if (!['label', 'rule'].includes(edit.field) || seen.has(edit.field)) throw new Error('変更する収集日の項目を確認してください。'); seen.add(edit.field);
    let next: JsonValue;
    if (edit.field === 'label') {
      if (typeof edit.value !== 'string' || !edit.value.trim() || edit.value.trim().length > 80) throw new Error('ゴミの種類は1〜80文字で入力してください。'); next = edit.value.trim();
    } else next = JSON.parse(canonicalJson(wasteCollectionRule({ ...edit.value as object, label: '収集日' } as unknown as WasteScheduleInput)));
    const base = readV2EditBasis({ view, at, type: 'waste', entityId: id, operationIds: edit.basisOperationIds,
      accepts: edit.field === 'label' ? operation => Object.hasOwn(operation.payload, 'label') : touchesRule,
      readValue: edit.field === 'label' ? operation => operation.payload.label : operation => v2WasteRuleAt(view, operation) });
    if (!compareV2ValueEdit(current.fields[edit.field], base, { ...edit, value: next })) continue;
    if (edit.field === 'label') patch.label = next; else Object.assign(patch, next);
  }
  return patch;
}

export function readV2WasteVisibility(view: V2HistoryView, at: SharedOperation, id: string, date: LocalDate) {
  const key = v2WasteVisibilityId(id, date); const fields = ['$alive', 'scheduleId', 'date', 'hidden'].map(field => readV2EditableField(view, at, 'wasteVisibility', key, field));
  const [alive, schedule, day, hidden] = fields;
  const inactive = alive.kind === 'missing' || alive.kind === 'value' && alive.value === false;
  const valid = !inactive && fields.every(field => field.kind === 'value') && value(schedule) === id && value(day) === date && typeof value(hidden) === 'boolean';
  return { hidden: inactive ? false : valid ? value(hidden) as boolean : null,
    revision: sharedDocumentDigest([view.groupId, key, ...fields.map(ids)]) };
}

export function buildV2WastePlan(view: V2HistoryView, at: SharedOperation, range: { from: LocalDate; through: LocalDate; asOfDate: LocalDate }) {
  const rows = [...new Set(view.ofType('waste').map(operation => operation.entityId))].sort(compareOperationIds).map(id => readV2Waste(view, at, id));
  const schedules = rows.flatMap(entry => entry.row.schedule ? [entry.row.schedule] : []);
  // Current management/home previews include five weeks; another month's query must stay bounded to that month.
  let through = range.through;
  if (range.from <= range.asOfDate && range.asOfDate <= range.through) try {
    const previewEnd = addDays(range.asOfDate, 35); if (previewEnd > through) through = previewEnd;
  } catch { /* Preserve the requested range at the supported date boundary. */ }
  const revisions = new Map(rows.map(entry => [entry.row.id, entry.row.revision]));
  const occurrences: V2WasteOccurrence[] = schedules.flatMap(schedule => generateWasteCollectionDates(schedule, range.from, through).map(occurrence => {
    const state = readV2WasteVisibility(view, at, schedule.id, occurrence.date); const revision = revisions.get(schedule.id)!;
    return { key: `${schedule.id}:${occurrence.date}`, occurrence, hidden: state.hidden,
      selection: { groupId: view.groupId, scheduleId: schedule.id, date: occurrence.date, scheduleRevision: revision, visibilityRevision: state.revision } };
  })).sort((a, b) => compareOperationIds(a.occurrence.date, b.occurrence.date) || compareOperationIds(a.key, b.key));
  return { range: { from: range.from, through }, rows: rows.map(entry => entry.row), schedules, occurrences,
    hiddenKeys: occurrences.filter(entry => entry.hidden === true).map(entry => entry.key) };
}
