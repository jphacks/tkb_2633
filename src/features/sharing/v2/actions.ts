import type { LocalDate } from '../../../domain/shared/types.ts';
import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import type { SharedOperationDraft } from '../../../platform/storage/sharing-ledger.ts';
import { canonicalJson } from '../operations.ts';
import type { JsonValue, SharedOperation } from '../operations.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { v2ReadPoint } from './view-point.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { frameAtOperation } from './authority-context.ts';
import { v2DatePermissionId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { recordedInstructionAt } from './recorded-instruction.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { v2CompletionHistory } from './completion-history.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { selectManualRule } from './period-rules.ts';
import { v2DateChangeOriginal } from './date-change-original.ts';
import { dateChangeContextAtOperation } from './receiver-authority.ts';
import { targetCivilDate, validateDesignationTarget } from './date-target.ts';
import { changeGroupKind } from './model.ts';
import { prepareV2ConfigurationEdit, mergeV2ConfigurationFieldEdits, V2StaleSettingsError } from './configuration-edit.ts';
import type { V2ConfigurationPatch, V2ConfigurationFieldEdit } from './configuration-edit.ts';
import { expandedCommonWindow } from './window-extension.ts';
import { v2DateDecisionReview } from './decision-review.ts';
import type { V2DateDecisionEdit } from './decision-review.ts';
import { v2AssignmentRequestReference, approvedV2AssignmentId, observedV2AssignmentCancellations } from './assignment-state.ts';
import type { DateTarget, DesignationMode, DesignationOptions, GroupKind, GroupPolicy, RuleSelector, SharedChoreConfiguration } from './model.ts';

export interface V2RoundReference { choreId: string; anchorDate: LocalDate; ruleVersion: number; subjectUserId: string | null;
  /** The displayed configuration frontier is an optimistic edit guard, never part of a signed business payload. */
  expectedConfigurationIds?: readonly string[]; expectedTimeZone?: string }
export interface V2AssignmentEdit { expectedAssignmentIds?: readonly string[]; expectedConflictIds?: readonly string[] }
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
  const sameIds = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
  function expectDisplayedState(state: State, ref: V2RoundReference) {
    if (ref.expectedConfigurationIds && !sameIds(ref.expectedConfigurationIds,
      maximalCausalFacts(state.assessment.view.topic('chorePolicy', ref.choreId)).map((op) => op.operationId))) throw new V2StaleSettingsError();
    if (ref.expectedTimeZone !== undefined && ref.expectedTimeZone !== state.assessment.view.field('settings', 'settings', 'timeZone', point(state))?.value) throw new V2StaleSettingsError();
  }
  const frame = (state: State, ref: V2RoundReference) => {
    expectDisplayedState(state, ref); return frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion);
  };
  function expectAssignment(context: ReturnType<typeof frame>, edit: V2AssignmentEdit) {
    if (edit.expectedAssignmentIds && !sameIds(edit.expectedAssignmentIds, context.assignmentOperationIds)
      || edit.expectedConflictIds && !sameIds(edit.expectedConflictIds, context.assignmentConflictIds)) throw new V2StaleSettingsError();
  }
  function datePlacementReview(state: State, ref: V2RoundReference, target: DateTarget, plan = buildV2CommonPlan(state,
    { from: ref.anchorDate, through: ref.anchorDate, asOfDate: ref.anchorDate })) {
    const civil = targetCivilDate(target, plan.timeZone);
    const subject = plan.occurrences.find((round) => round.choreId === ref.choreId && round.anchorDate === ref.anchorDate)?.subjects.find((slot) => slot.subjectUserId === ref.subjectUserId);
    const targetPlan = buildV2CommonPlan(state, { from: addDays(civil, -14), through: addDays(civil, 14), asOfDate: ref.anchorDate });
    const loads = new Map(targetPlan.chores.map((chore) => [chore.id, chore.load])); const load = loads.get(ref.choreId);
    const assignees = subject?.assigneeIds ?? frame(state, ref).assigneeIds;
    let count = 0;
    for (const round of targetPlan.occurrences) for (const slot of round.subjects) {
      if (slot.id === subject?.id || !slot.required || slot.completed || slot.suggestedDate !== civil || loads.get(round.choreId) !== load) continue;
      if (!assignees.length || !slot.assigneeIds.length || slot.assigneeIds.some((uid) => assignees.includes(uid))) count++;
    }
    const limit = plan.commonSettings[load === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit'];
    return { subject, recentWork: subject?.minimumNextExecutionDay !== null && subject?.minimumNextExecutionDay !== undefined && civil < subject.minimumNextExecutionDay,
      highLoad: load !== 'light' && typeof limit === 'number' && count + 1 > limit };
  }
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
  function assignmentCancellations(state: State, ids: readonly string[]): SharedOperationDraft[] {
    const at = point(state); const view = state.assessment.view; const cancelled = observedV2AssignmentCancellations(view, at);
    const sources = [...new Set(ids.map((id) => {
      const source = view.byId(id); if (source && ['assignmentRule', 'assignmentRequest'].includes(source.entityType)) return id;
      const request = view.ofType('assignmentRequest').find((op) => approvedV2AssignmentId(op) === id);
      if (!request) throw new Error('解除する担当指定を確認してください。'); return request.operationId;
    }))].filter((id) => !cancelled.has(id));
    return sources.length ? [draft('assignmentCancel', null, { targetOperationIds: sources })] : [];
  }
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
    complete: (ref: V2RoundReference, input: { performedAt?: string; performerUserId?: string; additionalWork?: boolean; expectedAssigneeIds?: readonly string[] } = {}) => {
      const performedAt = input.performedAt ?? options.now().toISOString();
      return repository.commitCurrent(async (state) => {
        const context = frame(state, ref); const at = point(state); const view = state.assessment.view;
        if (input.expectedAssigneeIds && !sameIds(input.expectedAssigneeIds, ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId])) throw new V2StaleSettingsError();
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
    resolveClaims: (ref: V2RoundReference, assigneeIds: string[], fixed: boolean, expectedClaimIds?: readonly string[]) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref);
      if (expectedClaimIds && !sameIds(expectedClaimIds, context.claims.activeClaimOperationIds)) throw new V2StaleSettingsError();
      return [draft('claimResolution', null, { choreId: ref.choreId, anchorDate: ref.anchorDate, occurrenceId: context.frame.id,
        claimOperationIds: context.claims.activeClaimOperationIds, assigneeIds, fixed })];
    }),
    assign: (ref: V2RoundReference, memberIds: string[], start: 'this' | 'next', fixed: boolean, edit: V2AssignmentEdit = {}) => repository.commitCurrent(async (state) => {
      expectDisplayedState(state, ref);
      const context = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      const anchor = start === 'next' ? addDays(ref.anchorDate, context.config.intervalDays) : ref.anchorDate;
      const next = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, anchor, ref.ruleVersion, { allowAssignmentConflict: true });
      expectAssignment(next, edit);
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: next.frame.id, fromAnchorDate: anchor,
        scope: 'from', memberIds, fixed, ruleVersion: next.config.ruleVersion, basisRuleIds: next.assignmentOperationIds })];
    }),
    resolveAssignment: (ref: V2RoundReference, memberIds: string[], scope: 'once' | 'from', fixed: boolean, edit: V2AssignmentEdit = {}) => repository.commitCurrent(async (state) => {
      expectDisplayedState(state, ref);
      const context = frameAtOperation(state.assessment.view, state.archive, point(state), ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      expectAssignment(context, edit);
      return [draft('assignmentRule', null, { choreId: ref.choreId, fromOccurrenceId: context.frame.id, fromAnchorDate: ref.anchorDate, scope, memberIds, fixed,
        ruleVersion: ref.ruleVersion, basisRuleIds: context.assignmentOperationIds,
        ...(context.assignmentReviewRequestIds.length ? { reviewedAssignmentRequestIds: context.assignmentReviewRequestIds } : {}) })];
    }),
    cancelAssignments: (sourceOperationIds: readonly string[]) => repository.commitCurrent(async (state) => assignmentCancellations(state, sourceOperationIds)),
    remapAssignments: (sourceOperationIds: readonly string[], ref: V2RoundReference, memberIds: string[], scope: 'once' | 'from', fixed: boolean, edit: V2AssignmentEdit = {}) => repository.commitCurrent(async (state) => {
      expectDisplayedState(state, ref);
      const cancellations = assignmentCancellations(state, sourceOperationIds); if (!cancellations.length) return [];
      const at = point(state); const context = frameAtOperation(state.assessment.view, state.archive, at, ref.choreId, ref.anchorDate, ref.ruleVersion, { allowAssignmentConflict: true });
      expectAssignment(context, edit);
      const sources = new Set(cancellations[0].payload.targetOperationIds as string[]);
      if ([...sources].some((id) => state.assessment.view.byId(id)?.payload.choreId !== ref.choreId)) throw new Error('同じ家事の中で担当を対応付けてください。');
      const remaining = state.assessment.view.assignmentsAt(at)?.facts.filter((fact) => fact.payload.choreId === ref.choreId && !sources.has(fact.sourceRequestId ?? fact.operationId)) ?? [];
      const reviews = context.assignmentReviewRequestIds.filter((id) => !sources.has(id));
      return [...cancellations, draft('assignmentRule', null, { choreId: ref.choreId, memberIds, fromOccurrenceId: context.frame.id, fromAnchorDate: ref.anchorDate,
        scope, fixed, ruleVersion: ref.ruleVersion, basisRuleIds: [...new Set(remaining.map((fact) => fact.operationId))].sort(),
        ...(reviews.length ? { reviewedAssignmentRequestIds: reviews } : {}) })];
    }),
    requestAssignment: (ref: V2RoundReference, input: { memberIds: string[]; start: 'this' | 'next'; scope: 'once' | 'from'; fixed: boolean } & V2AssignmentEdit) => repository.commitCurrent(async (state) => {
      const current = frame(state, ref); const anchor = input.start === 'next' ? addDays(ref.anchorDate, current.config.intervalDays) : ref.anchorDate;
      const at = point(state); const context = frame(state, { ...ref, anchorDate: anchor });
      expectAssignment(context, input);
      const reference = v2AssignmentRequestReference(state.assessment.view, at, context.frame,
        context.config.policy.completion === 'perMember' ? context.subjectUserIds : [], state.assessment.formalRulesAt(at));
      const proposal = { requesterUserId: scope.userId, choreId: ref.choreId, anchorDate: anchor, occurrenceId: context.frame.id,
        ruleVersion: context.config.ruleVersion, originalMemberIds: context.assigneeIds, originalAssignmentIds: context.assignmentOperationIds,
        originalClaimOperationIds: context.claims.activeClaimOperationIds, memberIds: [...input.memberIds].sort(), scope: input.scope, fixed: input.fixed, ...reference };
      if (state.assessment.assignmentRequests.some((request) => !request.cancelled && ['pendingDelivery', 'awaiting'].includes(request.kind)
        && canonicalJson(request.proposal) === canonicalJson(proposal))) return [];
      return [draft('assignmentRequest', null, proposal)];
    }),
    answerAssignment: (requestId: string, decision: 'approve' | 'reject') => repository.commitCurrent(async (state) => {
      const request = state.assessment.assignmentRequests.find((entry) => entry.requestId === requestId); if (!request) throw new Error('担当変更の申請を同期してください。');
      if (request.cancelled) throw new Error('この担当変更の指定は解除されています。現在の担当を確認してください。');
      if (request.kind === (decision === 'approve' ? 'approved' : 'rejected')) return [];
      if (!['pendingDelivery', 'awaiting'].includes(request.kind)) throw new Error('この申請は締め切られています。現在の担当を確認してください。');
      const previous = state.assessment.view.ofType('assignmentDecision').find((op) => op.payload.requestId === requestId && op.authorDeviceId === scope.deviceId);
      if (previous) { if (previous.payload.decision === decision) return []; throw new Error('すでに回答しています。現在の担当を確認してください。'); }
      return [draft('assignmentDecision', null, { requestId, decision })];
    }),
    grantDateRights: (choreId: string, userId: string, enabled: boolean, rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean }) =>
      repository.commit([draft('datePermission', v2DatePermissionId(scope.groupId, choreId, userId), { choreId, userId, enabled, rights })]),
    changeDate: (ref: V2RoundReference, input: { mode: DesignationMode; target: DateTarget; selector?: RuleSelector; options?: Partial<DesignationOptions>;
      extensionScope?: 'once' | 'future'; reviewedRequestIds?: string[]; expectedRuleIds?: string[]; confirmDateConflict?: boolean;
      expectedAssigneeIds?: readonly string[]; expectedAssignmentIds?: readonly string[]; expectedConflictIds?: readonly string[]; expectedRequestReviewIds?: readonly string[];
      confirmRecentWork?: boolean; confirmHighLoad?: boolean }) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); expectAssignment(context, input);
      if (input.expectedAssigneeIds && !sameIds(input.expectedAssigneeIds, ref.subjectUserId === null ? context.assigneeIds : [ref.subjectUserId])) throw new V2StaleSettingsError();
      const view = state.assessment.view; const at = point(state);
      const zone = view.field('settings', 'settings', 'timeZone', at)?.value as string;
      const target = validateDesignationTarget(input.mode, input.target);
      const rules = observedDateRules(view, at, state.assessment.formalRulesAt(at)); const selected = selectManualRule(rules, context.frame, ref.subjectUserId, zone);
      const originals = selected.kind === 'conflict' ? selected.candidates : selected.kind === 'selected' ? [selected.fact] : [];
      const { original, unresolved } = v2DateChangeOriginal(originals.map((fact) => fact.rule), context.frame, zone);
      const basisRuleIds = selected.kind === 'selected' ? selected.equivalentOperationIds : originals.map((fact) => fact.operationId);
      if (input.expectedRuleIds && canonicalJson([...input.expectedRuleIds].sort()) !== canonicalJson([...basisRuleIds].sort())) throw new V2StaleSettingsError();
      if ((selected.kind === 'conflict' || unresolved) && (!input.confirmDateConflict || !input.expectedRuleIds)) throw new V2StaleSettingsError();
      const selector = input.selector ?? { scope: 'once', occurrenceId: context.frame.id, anchorDate: ref.anchorDate };
      const proposedOptions = { strict: originals.some((fact) => fact.rule.strict), adminLocked: originals.some((fact) => fact.rule.adminLocked),
        forbidEarlier: originals.some((fact) => fact.rule.forbidEarlier), ...input.options };
      const plan = buildV2CommonPlan(state, { from: ref.anchorDate, through: ref.anchorDate, asOfDate: ref.anchorDate });
      const subject = plan.occurrences.find((round) => round.id === context.frame.id)?.subjects.find((slot) => slot.subjectUserId === ref.subjectUserId);
      if (input.expectedRequestReviewIds && !sameIds(input.expectedRequestReviewIds, subject?.requestReviewIds ?? [])) throw new V2StaleSettingsError();
      const civil = targetCivilDate(target, zone);
      if (subject?.dependencyNotBefore && civil < subject.dependencyNotBefore) throw new Error('先に必要な家事の実施日より後を指定してください。');
      if (subject?.dependencyBlocked && !subject.dependencyNotBefore) throw new Error('先に必要な家事の予定を確認してください。');
      const placement = datePlacementReview(state, ref, target, plan);
      if (placement.recentWork) {
        if (!input.confirmRecentWork) throw new V2ActionConfirmationError('recentWork'); proposedOptions.allowDuringCooldown = true;
      }
      if (placement.highLoad && !input.confirmHighLoad) throw new V2ActionConfirmationError('highLoad');
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
    decide: (requestId: string, decision: 'approve' | 'reject' | 'counteroffer' | 'acceptCounteroffer', target: DateTarget | null = null, referenceDecisionId: string | null = null, edit: V2DateDecisionEdit = {}) =>
      repository.commitCurrent(async (state) => {
        const current = state.assessment.requestStates.find((entry) => entry.requestId === requestId);
        if (!current) throw new Error('申請を同期してください。');
        const review = v2DateDecisionReview(state, requestId, scope.userId);
        if (edit.expectedDecisionIds && !sameIds(edit.expectedDecisionIds, review.answers.map((answer) => answer.operationId))
          || edit.expectedReviewRevision !== undefined && edit.expectedReviewRevision !== review.revision) throw new V2StaleSettingsError();
        if (['approved', 'rejected', 'expired', 'tooLate', 'blocked'].includes(current.kind)) return [];
        let allowDuringCooldown = false;
        if (decision !== 'reject') {
          const offer = decision === 'acceptCounteroffer' ? current.counteroffers.find((entry) => entry.operationId === referenceDecisionId) : null;
          const chosen = decision === 'approve' ? current.proposal.proposed : decision === 'counteroffer' ? target : offer?.target;
          if (!chosen) throw new Error('最新の代替日時を確認してください。');
          const p = current.proposal;
          const context = frameAtOperation(state.assessment.view, state.archive, point(state), p.choreId, p.anchorDate);
          const placement = datePlacementReview(state, { choreId: p.choreId, anchorDate: p.anchorDate, ruleVersion: context.config.ruleVersion, subjectUserId: p.subjectUserId }, validateDesignationTarget(p.proposedMode, chosen));
          if (placement.recentWork) {
            if (decision !== 'counteroffer' && !(offer?.options ?? p.proposedOptions).allowDuringCooldown) {
              throw new Error('申請後に最近の実施が見つかりました。管理者の代替案で再指定条件を明示し、本人の承諾を確認してください。');
            }
            if (!edit.confirmRecentWork) throw new V2ActionConfirmationError('recentWork');
            allowDuringCooldown = decision === 'counteroffer';
          }
          if (placement.highLoad && !edit.confirmHighLoad) throw new V2ActionConfirmationError('highLoad');
        }
        return [draft('requestDecision', null, { requestId, decision, target, referenceDecisionId, ...(allowDuringCooldown ? { allowDuringCooldown: true } : {}) })];
      }),
    approveSubstitution: (completionOperationId: string, decision: 'approve' | 'reject') => repository.commit([draft('completionApproval', null, { completionOperationId, decision })]),
    cancelDates: (ref: V2RoundReference, targetOperationIds: string[], edit: { expectedRuleIds?: readonly string[] } = {}) => repository.commitCurrent(async (state) => {
      const context = frame(state, ref); const rules = observedDateRules(state.assessment.view, point(state), state.assessment.formalRulesAt(point(state)), true);
      if (edit.expectedRuleIds) {
        const selected = selectManualRule(observedDateRules(state.assessment.view, point(state), state.assessment.formalRulesAt(point(state))), context.frame, ref.subjectUserId, state.assessment.view.field('settings', 'settings', 'timeZone', point(state))?.value as string);
        const currentIds = selected.kind === 'selected' ? selected.equivalentOperationIds : selected.kind === 'conflict' ? selected.candidates.map((fact) => fact.operationId) : [];
        if (!sameIds(edit.expectedRuleIds, currentIds)) throw new V2StaleSettingsError();
      }
      if (targetOperationIds.some((id) => !rules.some((fact) => fact.operationId === id && fact.rule.choreId === context.frame.choreId && fact.rule.subjectUserId === ref.subjectUserId))) throw new Error('取り消す日時指定を確認してください。');
      return [draft('designationCancel', null, { targetOperationIds })];
    }),
  };
}
