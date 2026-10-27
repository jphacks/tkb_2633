import type { LocalDate } from '../../../domain/shared/types.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2ReadPoint } from './view-point.ts';
import { frameAtOperation } from './authority-context.ts';
import { v2DatePermissionId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { recordedInstructionAt } from './recorded-instruction.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { v2CompletionHistory } from './completion-history.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { selectManualRule } from './period-rules.ts';
import { materializeRuleTarget } from './rule-target.ts';
import { dateChangeContextAtOperation } from './receiver-authority.ts';
import { targetCivilDate, targetReferenceTime, validateDesignationTarget } from './date-target.ts';
import { changeGroupKind } from './model.ts';
import { prepareV2ConfigurationEdit, mergeV2ConfigurationFieldEdits, V2StaleSettingsError } from './configuration-edit.ts';
import type { V2ConfigurationPatch, V2ConfigurationFieldEdit } from './configuration-edit.ts';
import { expandedCommonWindow } from './window-extension.ts';
import type { DateTarget, DesignationMode, DesignationOptions, GroupKind, GroupPolicy, RuleSelector, SharedChoreConfiguration } from './model.ts';

export interface V2RoundReference { choreId: string; anchorDate: LocalDate; ruleVersion: number; subjectUserId: string | null }
export class V2ActionConfirmationError extends Error {
  readonly code = 'sharing/v2-confirmation-required';
  readonly reason: 'recentWork' | 'highLoad';
  constructor(reason: 'recentWork' | 'highLoad') {
    super(reason === 'recentWork' ? '最近実施されていますが、もう一度指定しますか？' : 'この日は家事の負荷が高くなっています。この日に指定しますか？'); this.reason = reason;
  }
}
/** Every action reads authenticated state inside the same transaction that stores its signed facts and Outbox. */
export function createV2PlannerActions(repository: ReturnType<typeof createV2EventRepository>, options: { makeId: () => string; now: () => Date }) {
  const scope = repository.scope;
  const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  const draft = (entityType: SharedOperation['entityType'], entityId: string | null, payload: unknown, operationType: SharedOperation['operationType'] = 'patch'): SharedOperationDraft => {
    const operationId = options.makeId(); return { operationId, entityType, entityId: entityId ?? operationId, payload: json(payload), operationType };
  };
  type State = Awaited<ReturnType<typeof repository.readState>>;
  function point(state: State): SharedOperation {
    const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
    return { ...at, authorUserId: scope.userId, authorDeviceId: scope.deviceId, deviceSequence: (at.context[scope.deviceId] ?? 0) + 1 };
  }
  const frame = (state: State, ref: V2RoundReference) => frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion);
  const undoTargets = (targetOperationIds: readonly string[]) => repository.commitCurrent(async (state) => {
    const view = state.assessment.view; const result: SharedOperationDraft[] = [];
    for (const targetOperationId of new Set(targetOperationIds)) {
      const target = view.byId(targetOperationId);
      if (!target || target.entityType !== 'completion' || target.operationType !== 'complete') throw new Error('取り消す完了記録を確認してください。');
      if (view.ofType('completion').some((op) => op.operationType === 'undo' && op.payload.targetOperationId === targetOperationId)) continue;
      result.push(draft('completion', target.entityId, { targetOperationId }, 'undo'));
    }
    return result;
  });
  function configurationFieldDrafts(state: State, choreId: string, edits: readonly NonNullable<V2ConfigurationFieldEdit>[], effectiveFrom: LocalDate): SharedOperationDraft[] {
    const at = point(state); const enabled = state.assessment.view.field('chore', choreId, 'enabled', at)?.value === true;
    const current = state.assessment.view.field('chorePolicy', choreId, 'configuration', at)?.value as unknown as SharedChoreConfiguration | undefined;
    const activation = edits.find((entry) => entry.field === 'active'); const prepared = [...edits];
    if (activation?.value === true && (!enabled || current?.active === false) && !prepared.some((entry) => entry.field === 'anchorDate')) {
      prepared.push({ field: 'anchorDate', baseRuleVersion: activation.baseRuleVersion, value: effectiveFrom });
    }
    const edit = mergeV2ConfigurationFieldEdits({ view: state.assessment.view, at, choreId, edits: prepared, effectiveFrom });
    if (!edit) return activation && typeof activation.value === 'boolean' && activation.value !== enabled
      ? [draft('chore', choreId, { enabled: activation.value, requiresCycleSelection: false })] : [];
    const configuration = prepareV2ConfigurationEdit({ view: state.assessment.view, archive: state.archive, at: point(state), choreId, ...edit });
    return [draft('chorePolicy', choreId, { configuration }), draft('chore', choreId, { enabled: configuration.active !== false, requiresCycleSelection: false })];
  }
  const configureFields = (choreId: string, edits: readonly NonNullable<V2ConfigurationFieldEdit>[], effectiveFrom: LocalDate) =>
    repository.commitCurrent(async (state) => configurationFieldDrafts(state, choreId, edits, effectiveFrom));
  return {
    readPlan: async (range: Parameters<typeof buildV2CommonPlan>[1]) => buildV2CommonPlan(await repository.readState(), range),
    addChore: (name: string, instructions: string[] = []) => {
      const id = options.makeId(); return repository.commit([draft('chore', id, { name: name.trim(), instructions, enabled: false })]);
    },
    patchChore: (choreId: string, patch: Record<string, JsonValue>, effectiveFrom?: LocalDate) => {
      const operationTime = options.now();
      return repository.commitCurrent(async (state) => {
        if (typeof patch.enabled !== 'boolean' || scope.userId !== state.archive.at(-1)!.body.ownerUserId) return [draft('chore', choreId, patch)];
        const current = state.assessment.view.field('chorePolicy', choreId, 'configuration', point(state))?.value as unknown as SharedChoreConfiguration | undefined;
        if (!current) {
          if (patch.enabled) throw new Error('周期と担当の種類を設定してから、この家事を有効にしてください。');
          return [draft('chore', choreId, patch)];
        }
        const zone = state.assessment.view.field('settings', 'settings', 'timeZone', point(state))?.value;
        if (typeof zone !== 'string') throw new Error('グループ設定を同期してください。');
        const from = effectiveFrom ?? sharedLocalDate(operationTime, zone);
        const operations = configurationFieldDrafts(state, choreId, [{ field: 'active', value: patch.enabled, baseRuleVersion: current.ruleVersion }], from);
        const { enabled: _enabled, ...other } = patch;
        if (Object.keys(other).length) operations.push(draft('chore', choreId, other));
        return operations;
      });
    },
    configureChore: (choreId: string, value: Omit<SharedChoreConfiguration, 'ruleVersion'>, edit: { expectedRuleVersion?: number; preserveAssignments?: boolean; resolveConfigurationIds?: string[] } = {}) => repository.commitCurrent(async (state) => {
      const configuration = prepareV2ConfigurationEdit({ view: state.assessment.view, archive: state.archive, at: point(state), choreId, value, ...edit });
      return [draft('chorePolicy', choreId, { configuration }), draft('chore', choreId, { enabled: value.active !== false, requiresCycleSelection: false })];
    }),
    patchChoreConfiguration: (choreId: string, baseRuleVersion: number, patch: V2ConfigurationPatch, effectiveFrom: LocalDate) => configureFields(choreId,
      Object.entries(patch).map(([field, value]) => ({ field, value, baseRuleVersion }) as NonNullable<V2ConfigurationFieldEdit>), effectiveFrom),
    patchChoreConfigurationFields: configureFields,
    changeGroupKind: (kind: GroupKind) => repository.commitCurrent(async (state) => {
      const current = state.assessment.view.field('groupPolicy', 'policy', 'configuration', point(state));
      if (!current) throw new Error('グループ設定を同期してください。');
      return [draft('groupPolicy', 'policy', { configuration: changeGroupKind(current.value as unknown as GroupPolicy, kind) })];
    }),
    patchGroupPolicy: (patch: Partial<GroupPolicy>) => repository.commitCurrent(async (state) => {
      const current = state.assessment.view.field('groupPolicy', 'policy', 'configuration', point(state));
      if (!current) throw new Error('グループ設定を同期してください。');
      return [draft('groupPolicy', 'policy', { configuration: { ...current.value as object, ...patch } })];
    }),
    complete: (ref: V2RoundReference, input: { performedAt?: string; performerUserId?: string; additionalWork?: boolean } = {}) => {
      const performedAt = input.performedAt ?? options.now().toISOString();
      return repository.commitCurrent(async (state) => {
        const context = frame(state, ref); const at = point(state); const view = state.assessment.view;
        const history = v2CompletionHistory(view, at, state.receipts);
        if (!input.additionalWork && history.some((record) => record.occurrenceId === context.frame.id && record.subjectUserId === ref.subjectUserId && record.active && record.outcome === 'completed')) return [];
        const instruction = recordedInstructionAt(view, at, context.frame, ref.subjectUserId, state.assessment.formalRulesAt(at));
        const scheduledDate = instruction.kind === 'designated' ? targetCivilDate(instruction.target, instruction.timeZone) : ref.anchorDate;
        const commonWindow = expandedCommonWindow({ frame: context.frame, timeZone: instruction.timeZone, view, at, requests: state.assessment.requestStates,
          approvedRules: state.assessment.formalRulesAt(at), receiptEpochs: state.assessment.receiptEpochs });
        const windowStart = instruction.kind === 'designated' && scheduledDate < commonWindow.windowStart ? scheduledDate : commonWindow.windowStart;
        const windowEnd = instruction.kind === 'designated' && scheduledDate > commonWindow.windowEnd ? scheduledDate : commonWindow.windowEnd;
        return [draft('completion', v2SubjectOccurrenceId(context.frame.id, ref.subjectUserId), { choreId: ref.choreId, anchorDate: ref.anchorDate,
          subjectUserId: ref.subjectUserId, ruleVersion: context.config.ruleVersion, completedAt: performedAt, completedByMemberId: input.performerUserId ?? scope.userId,
          originalAssigneeIds: ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId], outcome: 'completed',
          recordedInstruction: instruction, recordedCommonWindow: { start: commonWindow.windowStart, end: commonWindow.windowEnd }, scheduledDate,
          scheduledWindowStart: windowStart, scheduledWindowEnd: windowEnd,
          completionNote: input.performedAt ? 'alreadyDone' : 'completedNow' }, 'complete')];
      });
    },
    undo: (targetOperationId: string) => undoTargets([targetOperationId]),
    undoMany: undoTargets,
    claim: (ref: V2RoundReference) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref);
      if (context.assigneeIds.includes(scope.userId)) return [];
      return [draft('claim', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id, userId: scope.userId })];
    }),
    releaseClaim: (ref: V2RoundReference) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); const view = state.assessment.view;
      const targets = context.claims.activeClaimOperationIds.filter((id) => view.byId(id)?.authorUserId === scope.userId);
      if (!targets.length) return [];
      return [draft('claimRelease', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id, userId: scope.userId, targetOperationIds: targets })];
    }),
    resolveClaims: (ref: V2RoundReference, assigneeIds: string[], fixed: boolean) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref);
      return [draft('claimResolution', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id,
        claimOperationIds: context.claims.activeClaimOperationIds, assigneeIds, fixed })];
    }),
    assign: (ref: V2RoundReference, memberIds: string[], start: 'this' | 'next', fixed: boolean) => repository.commitCurrent(async (state) => {
      const context = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      const anchor = start === 'next' ? addDays(ref.anchorDate, context.config.intervalDays) : ref.anchorDate;
      const next = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, anchor, ref.ruleVersion, { allowAssignmentConflict: true });
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: next.frame.id, fromAnchorDate: anchor,
        scope: 'from', memberIds, fixed, ruleVersion: next.config.ruleVersion })];
    }),
    resolveAssignment: (ref: V2RoundReference, memberIds: string[], scope: 'once' | 'from', fixed: boolean) => repository.commitCurrent(async (state) => {
      const context = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: context.frame.id, fromAnchorDate: ref.anchorDate, scope, memberIds, fixed, ruleVersion: ref.ruleVersion })];
    }),
    grantDateRights: (choreId: string, userId: string, enabled: boolean, rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean }) =>
      repository.commit([draft('datePermission', v2DatePermissionId(scope.groupId, choreId, userId), { choreId, userId, enabled, rights })]),
    changeDate: (ref: V2RoundReference, input: { mode: DesignationMode; target: DateTarget; selector?: RuleSelector; options?: Partial<DesignationOptions>;
      extensionScope?: 'once' | 'future'; reviewedRequestIds?: string[]; expectedRuleIds?: string[]; confirmDateConflict?: boolean;
      confirmRecentWork?: boolean; confirmHighLoad?: boolean }) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); const view = state.assessment.view; const at = point(state);
      const zone = view.field('settings', 'settings', 'timeZone', at)?.value as string;
      const target = validateDesignationTarget(input.mode, input.target);
      const rules = observedDateRules(view, at, state.assessment.formalRulesAt(at)); const selected = selectManualRule(rules, context.frame, ref.subjectUserId, zone);
      const originals = selected.kind === 'conflict' ? selected.candidates : selected.kind === 'selected' ? [selected.fact] : [];
      const targets = originals.map((fact) => { const result = materializeRuleTarget(fact.rule, context.frame, zone); if (result.kind !== 'target') throw new Error('周期や時刻の適用を確認してください。'); return result.target; });
      const original = targets.sort((a, b) => targetReferenceTime(a, zone) - targetReferenceTime(b, zone))[0] ?? { precision: 'date', date: ref.anchorDate };
      const basisRuleIds = selected.kind === 'selected' ? selected.equivalentOperationIds : originals.map((fact) => fact.operationId);
      if (input.expectedRuleIds && canonicalJson([...input.expectedRuleIds].sort()) !== canonicalJson([...basisRuleIds].sort())) throw new V2StaleSettingsError();
      if (selected.kind === 'conflict' && (!input.confirmDateConflict || !input.expectedRuleIds)) throw new V2StaleSettingsError();
      const selector = input.selector ?? { scope: 'once', occurrenceId: context.frame.id, anchorDate: ref.anchorDate };
      const proposedOptions = { strict: originals.some((fact) => fact.rule.strict), adminLocked: originals.some((fact) => fact.rule.adminLocked),
        forbidEarlier: originals.some((fact) => fact.rule.forbidEarlier), ...input.options };
      const plan = buildV2CommonPlan(state, { from: ref.anchorDate, through: ref.anchorDate, asOfDate: ref.anchorDate });
      const subject = plan.occurrences.find((round) => round.id === context.frame.id)?.subjects.find((slot) => slot.subjectUserId === ref.subjectUserId);
      const civil = targetCivilDate(target, zone);
      if (subject?.dependencyNotBefore && civil < subject.dependencyNotBefore) throw new Error('先に必要な家事の実施日より後を指定してください。');
      if (subject?.dependencyBlocked && !subject.dependencyNotBefore) throw new Error('先に必要な家事の予定を確認してください。');
      if (subject?.minimumNextExecutionDay && civil < subject.minimumNextExecutionDay) {
        if (!input.confirmRecentWork) throw new V2ActionConfirmationError('recentWork'); proposedOptions.allowDuringCooldown = true;
      }
      const targetPlan = buildV2CommonPlan(state, { from: addDays(civil, -14), through: addDays(civil, 14), asOfDate: ref.anchorDate });
      const load = plan.chores.find((chore) => chore.id === ref.choreId)?.load;
      const assignees = ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId];
      let count = 0;
      for (const round of targetPlan.occurrences) for (const slot of round.subjects) {
        if (slot.id === subject?.id || !slot.required || slot.completed || slot.suggestedDate !== civil
          || targetPlan.chores.find((chore) => chore.id === round.choreId)?.load !== load) continue;
        if (!assignees.length || !slot.assigneeIds.length || slot.assigneeIds.some((uid) => assignees.includes(uid))) count++;
      }
      const limit = plan.commonSettings[load === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit'];
      if (load !== 'light' && typeof limit === 'number' && count + 1 > limit && !input.confirmHighLoad) throw new V2ActionConfirmationError('highLoad');
      const request = draft('changeRequest', null, { requesterUserId: scope.userId, choreId: ref.choreId, anchorDate: ref.anchorDate,
        occurrenceId: context.frame.id, subjectUserId: ref.subjectUserId, originalDesignationId: selected.kind === 'selected' ? selected.fact.operationId : null,
        original, proposed: target, proposedMode: input.mode, proposedOptions, selector, extensionScope: input.extensionScope ?? 'once',
        ...(basisRuleIds.length ? { basisRuleIds } : {}), ...(input.reviewedRequestIds?.length ? { reviewedRequestIds: input.reviewedRequestIds } : {}) });
      const probe = { ...at, ...request };
      const permission = dateChangeContextAtOperation(view, state.archive, probe, undefined, state.assessment.formalRulesAt(at), new Map(state.assessment.requestStates.map((entry) => [entry.requestId, entry])),
        { receipts: state.receipts, epochs: state.assessment.receiptEpochs }).permission;
      if (permission.kind === 'denied') throw new Error(permission.reason === 'fixedConflict' ? 'この時間帯は別の家事を行う必要があります。別の時間帯を指定してください'
        : permission.reason === 'dependency' ? '先に必要な家事の実施日時を確認してください。' : 'この日時を変更する権限を確認してください。');
      if (permission.kind !== 'allowed' || permission.needsRequest || input.extensionScope === 'future') return [request];
      return [{ ...request, entityType: 'designation', payload: json({ configuration: { id: request.operationId, choreId: ref.choreId, subjectUserId: ref.subjectUserId,
        selector, referenceAnchorDate: ref.anchorDate, timeZoneAtCreation: zone, mode: input.mode, target, ...proposedOptions,
        issuerUserId: scope.userId, ruleVersion: ref.ruleVersion, ...(basisRuleIds.length ? { basisRuleIds } : {}),
        ...(input.reviewedRequestIds?.length ? { reviewedRequestIds: input.reviewedRequestIds } : {}) } }) }];
    }),
    decide: (requestId: string, decision: 'approve' | 'reject' | 'counteroffer' | 'acceptCounteroffer', target: DateTarget | null = null, referenceDecisionId: string | null = null) =>
      repository.commitCurrent(async (state) => {
        const current = state.assessment.requestStates.find((entry) => entry.requestId === requestId);
        if (!current) throw new Error('申請を同期してください。');
        if (['approved', 'rejected', 'expired', 'tooLate', 'blocked'].includes(current.kind)) return [];
        return [draft('requestDecision', null, { requestId, decision, target, referenceDecisionId })];
      }),
    approveSubstitution: (completionOperationId: string, decision: 'approve' | 'reject') => repository.commit([draft('completionApproval', null, { completionOperationId, decision })]),
    cancelDates: (ref: V2RoundReference, targetOperationIds: string[]) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); const rules = observedDateRules(state.assessment.view, point(state), state.assessment.formalRulesAt(point(state)), true);
      if (targetOperationIds.some((id) => !rules.some((fact) => fact.operationId === id && fact.rule.choreId === context.frame.choreId && fact.rule.subjectUserId === ref.subjectUserId))) throw new Error('取り消す日時指定を確認してください。');
      return [draft('designationCancel', null, { targetOperationIds })];
    }),
  };
}
