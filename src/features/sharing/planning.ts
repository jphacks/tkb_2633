import { createHouseholdChoreDefinitions } from '../../domain/chores/catalog.ts';
import type { ChoreCompletion, ChoreDefinition, ChoreDependency, ChoreState, HouseholdPlannerSettings } from '../../domain/chores/types.ts';
import { DEFAULT_CALENDAR_COUNT_COLORS } from '../../domain/calendar/count-colors.ts';
import { completionCycleDate } from '../../domain/scheduling/completion-matching.ts';
import { generateHouseworkSchedule, wouldCreateDependencyCycle } from '../../domain/scheduling/engine.ts';
import { addDays } from '../../domain/scheduling/local-date.ts';
import type { LocalDate, Weekday } from '../../domain/shared/types.ts';
import type { Appliance } from '../appliance-care/contracts.ts';
import type { WeeklyWasteSchedule } from '../waste/contracts.ts';
import { normalizeWasteSchedule } from '../waste/schedule-policy.ts';
import { generateWeeklyCollectionDates } from '../waste/weekly-scheduler.ts';
import { splitWasteOccurrencesByVisibility } from '../waste/occurrence-visibility.ts';
import type { PlannerSnapshot } from '../../platform/storage/repository.ts';
import type { SharedOperationDraft } from '../../platform/storage/sharing-ledger.ts';
import { canonicalJson, compareOperationIds } from './operations.ts';
import type { JsonValue, SharedOperation } from './operations.ts';
import type { SharedEntity, SharedReplica } from './replica.ts';
import { sharedLocalDate } from './group-clock.ts';

export interface SharedPlanningIssue { entityType: string; entityId: string; fields: string[]; kind: 'conflict' | 'invalid' | 'dependencyCycle' | 'orphanAssignment' }
export function sharedPatchFromDefinition(definition: ChoreDefinition): Record<string, JsonValue> {
  const { id: _id, householdId: _householdId, ...fields } = definition;
  return JSON.parse(JSON.stringify(fields)) as Record<string, JsonValue>;
}

/** A fresh group starts separately with all built-ins disabled; personal data is never read. */
export function sharedGroupBootstrap(options: { groupId: string; ownerUserId: string; ownerDisplayName: string;
  name: string; timeZone: string; anchorDate: LocalDate }): SharedOperationDraft[] {
  const drafts: SharedOperationDraft[] = [];
  const add = (entityType: SharedOperation['entityType'], entityId: string, payload: Record<string, JsonValue>) => {
    drafts.push({ operationId: `${options.groupId}.bootstrap.${drafts.length}`, entityType, entityId, operationType: 'patch', payload });
  };
  add('settings', 'settings', { name: options.name, timeZone: options.timeZone, anchorDate: options.anchorDate,
    frequencyMode: 'balanced', restDays: [6, 7], heavyDailyLimit: 1, normalDailyLimit: 2 });
  add('member', `member:${options.ownerUserId}`, { userId: options.ownerUserId, displayName: options.ownerDisplayName });
  for (const builtIn of createHouseholdChoreDefinitions('unused-bootstrap-household')) {
    const definition = { ...builtIn, id: `${options.groupId}.${builtIn.id}`, enabled: false };
    add('chore', definition.id, sharedPatchFromDefinition(definition));
    add('baseline', definition.id, { lastCompletedDate: null, lastCompletedEstimated: false,
      initialPending: true, initialScheduledDate: null, unknownReason: 'unknown' });
  }
  return drafts;
}

function materializedFields(entity: SharedEntity): Record<string, JsonValue> {
  return Object.fromEntries(Object.entries(entity.fields).filter(([, value]) => value !== null));
}
function incompleteHistory(replica: SharedReplica): ChoreCompletion[] {
  const effective = new Map(replica.completions.map((completion) => [completion.occurrenceId, completion]));
  const byOccurrence = new Map<string, SharedOperation[]>();
  const pending = new Set(replica.pendingOperationIds);
  for (const op of replica.operations) if (op.entityType === 'completion' && op.operationType === 'complete'
    && !pending.has(op.operationId)) {
    const entries = byOccurrence.get(op.entityId) ?? []; entries.push(op); byOccurrence.set(op.entityId, entries);
  }
  return [...byOccurrence.entries()].map(([occurrence, facts]) => {
    const active = effective.get(occurrence);
    const chosen = facts.find((op) => op.operationId === active?.operationId) ?? facts.sort((a, b) => compareOperationIds(a.operationId, b.operationId))[0];
    const payload = chosen.payload;
    return { ...payload, id: chosen.operationId, householdId: '', choreId: payload.choreId as string,
      completedAt: payload.completedAt as string, completedLocalDate: payload.completedLocalDate as LocalDate | undefined,
      completedByMemberId: (payload.completedByMemberId as string | undefined) ?? chosen.authorUserId,
      scheduleEntryId: occurrence, outcome: active ? payload.outcome as 'completed' | 'incomplete' : 'incomplete', source: 'inApp' as const };
  }).sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt) || compareOperationIds(a.id, b.id));
}

/** Only shared canonical inputs reach the scheduler. No private weather, FreeBusy or previous local schedule. */
export function buildSharedPlannerSnapshot(replica: SharedReplica, options: {
  householdId: string; now: Date; privateSettings?: Partial<HouseholdPlannerSettings>; activeMemberIds?: readonly string[];
}): PlannerSnapshot {
  const { householdId } = options; const issues: SharedPlanningIssue[] = [];
  for (const entity of replica.entities) if (Object.keys(entity.conflicts).length) issues.push({ entityType: entity.entityType,
    entityId: entity.entityId, fields: Object.keys(entity.conflicts), kind: 'conflict' });
  const living = replica.entities.filter((entity) => !entity.deleted);
  const settingsEntity = living.find((entity) => entity.entityType === 'settings' && entity.entityId === 'settings');
  const common = settingsEntity ? materializedFields(settingsEntity) : {};
  const timeZone = typeof common.timeZone === 'string' ? common.timeZone : 'UTC';
  const today = sharedLocalDate(options.now, timeZone);
  const anchor = typeof common.anchorDate === 'string' ? common.anchorDate as LocalDate : today;
  const settingsConflict = !settingsEntity || Object.keys(settingsEntity.conflicts).length > 0;
  if (!settingsEntity) issues.push({ entityType: 'settings', entityId: 'settings', fields: [], kind: 'invalid' });
  const privateSettings = options.privateSettings;
  const settings: HouseholdPlannerSettings = { householdId,
    frequencyMode: (common.frequencyMode as HouseholdPlannerSettings['frequencyMode']) ?? 'balanced',
    restDays: (common.restDays as number[]) ?? [6, 7], heavyDailyLimit: (common.heavyDailyLimit as number) ?? 1,
    normalDailyLimit: (common.normalDailyLimit as number) ?? 2, notificationHour: privateSettings?.notificationHour ?? 9,
    notificationMinute: privateSettings?.notificationMinute ?? 0, notificationsEnabled: privateSettings?.notificationsEnabled ?? false,
    setupCompleted: true, calendarCountColors: privateSettings?.calendarCountColors ?? DEFAULT_CALENDAR_COUNT_COLORS,
    calendarCountDisplayMode: privateSettings?.calendarCountDisplayMode ?? 'bar' };
  const chores: ChoreDefinition[] = replica.entities.filter((entity) => entity.entityType === 'chore').map((entity) => {
    const fields = materializedFields(entity);
    return { description: '', category: '家事', frequencyDaysByMode: { frequent: 7, balanced: 7, relaxed: 7 },
      windowRadiusDays: 2, maxShiftDays: 4, load: 'normal', holidayPriority: false, everyday: false,
      instructions: [], tools: [], cautions: [], ...fields,
      id: entity.entityId, householdId, name: typeof fields.name === 'string' ? fields.name : '家事（設定を確認）',
      archived: fields.archived === true || (entity.deleted && !entity.conflicts.$alive),
      enabled: fields.enabled === true && !fields.archived && !entity.deleted && !fields.requiresCycleSelection
        && !settingsConflict && !Object.keys(entity.conflicts).length,
    } as ChoreDefinition;
  }).sort((a, b) => compareOperationIds(a.id, b.id));
  const choreIds = new Set(chores.map((chore) => chore.id));
  const completions = incompleteHistory(replica).map((completion) => ({ ...completion, householdId }));
  for (const completion of completions) if (!choreIds.has(completion.choreId)) {
    // Preserve an orphaned history record without inventing an executable procedure.
    chores.push({ id: completion.choreId, householdId, name: '未登録の家事', category: '家事', description: '', enabled: false, archived: true,
      frequencyDaysByMode: { frequent: 7, balanced: 7, relaxed: 7 }, windowRadiusDays: 0, maxShiftDays: 0, load: 'normal',
      holidayPriority: false, everyday: false, instructions: [], tools: [], cautions: [] });
    choreIds.add(completion.choreId); issues.push({ entityType: 'completion', entityId: completion.scheduleEntryId!, fields: ['choreId'], kind: 'invalid' });
  }
  const completedByChore = new Map<string, ChoreCompletion>();
  for (const completion of completions) {
    if (completion.outcome !== 'completed') continue;
    const date = completionCycleDate(completion);
    if (date > today || (completedByChore.has(completion.choreId) && completionCycleDate(completedByChore.get(completion.choreId)!) >= date)) continue;
    completedByChore.set(completion.choreId, completion);
  }
  const baselines = new Map(living.filter((entity) => entity.entityType === 'baseline').map((entity) => [entity.entityId, entity]));
  const states: ChoreState[] = chores.map((chore) => {
    const baseline = baselines.get(chore.id); const fields = baseline ? materializedFields(baseline) : {};
    if (baseline && Object.keys(baseline.conflicts).length) chore.enabled = false;
    const completed = completedByChore.get(chore.id); const historyDate = completed ? completionCycleDate(completed) : undefined;
    const initial = { choreId: chore.id, lastCompletedDate: fields.lastCompletedDate as LocalDate | undefined,
      lastCompletedEstimated: fields.lastCompletedEstimated === true, initialPending: fields.initialPending !== false,
      initialScheduledDate: (fields.initialScheduledDate as LocalDate | undefined) ?? (chore.enabled ? anchor : undefined),
      unknownReason: fields.unknownReason as ChoreState['unknownReason'] };
    return historyDate && (!initial.lastCompletedDate || historyDate >= initial.lastCompletedDate)
      ? { choreId: chore.id, lastCompletedDate: historyDate, lastCompletedEstimated: false, initialPending: false } : initial;
  });
  const members = replica.entities.filter((entity) => entity.entityType === 'member').map((entity) => ({
    id: entity.fields.userId as string, householdId, displayName: (entity.fields.displayName as string) ?? 'メンバー',
  })).filter((member) => typeof member.id === 'string').sort((a, b) => compareOperationIds(a.id, b.id));
  const activeMembers = new Set(options.activeMemberIds ?? members.map((member) => member.id));
  for (const entity of living.filter((entity) => entity.entityType === 'member' && (entity.fields.userId as string | undefined)?.startsWith('manual:'))) activeMembers.add(entity.fields.userId as string);
  const knownMembers = new Set(members.map((member) => member.id));
  for (const id of [...activeMembers, ...completions.map((completion) => completion.completedByMemberId).filter((id): id is string => Boolean(id))]) {
    if (!knownMembers.has(id)) { members.push({ id, householdId, displayName: activeMembers.has(id) ? 'メンバー' : '以前のメンバー' }); knownMembers.add(id); }
  }
  const assignments = living.filter((entity) => entity.entityType === 'assignment' && !Object.keys(entity.conflicts).length)
    .filter((entity) => choreIds.has(entity.fields.choreId as string)).map((entity) => {
      const memberIds = (entity.fields.memberIds as string[] | undefined) ?? [];
      if (memberIds.some((id) => !activeMembers.has(id))) issues.push({ entityType: 'assignment', entityId: entity.entityId, fields: ['memberIds'], kind: 'orphanAssignment' });
      return { choreId: entity.fields.choreId as string, memberIds: memberIds.filter((id) => activeMembers.has(id)) };
    });
  const dependencies: ChoreDependency[] = [];
  let invalidDependencies = replica.entities.some((entity) => entity.entityType === 'dependency' && Object.keys(entity.conflicts).length);
  for (const entity of living.filter((entity) => entity.entityType === 'dependency' && !Object.keys(entity.conflicts).length)) {
    const predecessorChoreId = entity.fields.predecessorChoreId as string; const successorChoreId = entity.fields.successorChoreId as string;
    if (!choreIds.has(predecessorChoreId) || !choreIds.has(successorChoreId)) continue;
    if (wouldCreateDependencyCycle(dependencies, predecessorChoreId, successorChoreId)) {
      invalidDependencies = true; issues.push({ entityType: 'dependency', entityId: entity.entityId, fields: [], kind: 'dependencyCycle' });
    } else dependencies.push({ id: entity.entityId, predecessorChoreId, successorChoreId, policyData: entity.fields.policyData });
  }
  if (invalidDependencies) for (const chore of chores) chore.enabled = false;
  const wasteSchedules: WeeklyWasteSchedule[] = [];
  for (const entity of living.filter((entity) => entity.entityType === 'waste' && !Object.keys(entity.conflicts).length)) {
    try {
      const fields = materializedFields(entity);
      wasteSchedules.push({ ...normalizeWasteSchedule({ ...fields, id: entity.entityId } as unknown as WeeklyWasteSchedule), id: entity.entityId, householdId });
    } catch { issues.push({ entityType: 'waste', entityId: entity.entityId, fields: [], kind: 'invalid' }); }
  }
  const wasteIds = new Set(wasteSchedules.map((schedule) => schedule.id));
  const hiddenKeys = new Set(living.filter((entity) => entity.entityType === 'wasteVisibility' && entity.fields.hidden === true
    && wasteIds.has(entity.fields.scheduleId as string)
    && !Object.keys(entity.conflicts).length).map((entity) => `${entity.fields.scheduleId}:${entity.fields.date}`));
  const waste = splitWasteOccurrencesByVisibility(wasteSchedules.flatMap((schedule) => generateWeeklyCollectionDates(schedule, today, addDays(today, 35))), hiddenKeys);
  const appliances: Appliance[] = [];
  for (const entity of living.filter((entity) => entity.entityType === 'appliance' && !Object.keys(entity.conflicts).length)) {
    const fields = materializedFields(entity);
    if (fields.reviewed === true && fields.analysis && ['manufacturer', 'productName', 'modelNumber', 'displayName', 'officialManualUrl', 'createdAt', 'updatedAt']
      .every((key) => typeof fields[key] === 'string')) appliances.push({ ...fields, id: entity.entityId, householdId } as unknown as Appliance);
    else issues.push({ entityType: 'appliance', entityId: entity.entityId, fields: [], kind: 'invalid' });
  }
  const scheduleEntries = generateHouseworkSchedule({ householdId, today, from: today, through: addDays(today, 180), chores, states,
    assignments, dependencies, completions, settings: { frequencyMode: settings.frequencyMode, restDays: settings.restDays as Weekday[],
      loadLimits: { heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit } } })
    .sort((a, b) => compareOperationIds(a.suggestedDate, b.suggestedDate) || compareOperationIds(a.id, b.id));
  return { today, timeZone, sharing: { groupId: replica.groupId, activeMemberIds: [...activeMembers].sort(compareOperationIds), issues },
    household: { id: householdId, name: (common.name as string) ?? '共有グループ', createdAt: `${anchor}T00:00:00.000Z` },
    settings, chores, appliances, states, members, assignments, dependencies, scheduleEntries, completions,
    wasteSchedules, upcomingWasteDates: waste.visible, hiddenWasteDates: waste.hidden, hiddenWasteOccurrenceKeys: [...hiddenKeys].sort(compareOperationIds),
    weatherOutcome: 'disabled', weatherAdjustmentCount: 0 };
}

export function sharedPlanningSignature(snapshot: PlannerSnapshot): string {
  return canonicalJson({ today: snapshot.today, timeZone: snapshot.timeZone, entries: snapshot.scheduleEntries,
    issues: snapshot.sharing?.issues ?? [] });
}
