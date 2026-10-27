import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation, VersionVector } from '../operations.ts';
import type { SharedReplica } from '../replica.ts';
import { sharedAuthorIdentity } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { v2DatePermissionId, v2SubjectOccurrenceId } from './occurrence-id.ts';
import { createV2AuthorityIndex, V2HistoryConflictError } from './history-view.ts';
import type { V2HistoryView } from './history-view.ts';
import { frameAtOperation, groupPolicyAt, rosterAtOperation } from './authority-context.ts';
import { deriveClaims } from './claims.ts';
import type { ClaimFact, ClaimRelease, ClaimResolution } from './claims.ts';
import { evaluateDateChangePermission, mayUndoCompletion } from './permissions.ts';
import type { DatePermissionFact, DateChangePermission } from './permissions.ts';
import { normalizeDateTarget, targetCivilDate, targetReferenceTime, validateDesignationTarget } from './date-target.ts';
import type { DateTarget, DesignationMode, DesignationOptions, ManualRule, ManualRuleFact, SharedChoreConfiguration } from './model.ts';
import { selectManualRule } from './period-rules.ts';
import { materializeRuleTarget } from './rule-target.ts';
import { fixedConflictAtOperation } from './fixed-conflict.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';

export class V2AuthorityError extends Error { readonly code = 'sharing/v2-authority-denied'; }
export interface VerifiedLegacyMigration {
  /** Taken from the locally verified source snapshot, never from a proposed operation's payload. */
  sourceSnapshotDigest: string;
  frontier: VersionVector;
}
const CHORE_COMMON_FIELDS = new Set(['enabled', 'archived', 'recommendedCycleDays', 'userIntervalDays', 'manufacturerRecommendedIntervalDays',
  'requiresCycleSelection', 'frequencyDaysByMode', 'windowRadiusDays', 'maxShiftDays', 'load', 'holidayPriority', 'everyday', 'estimatedMinutes', 'laundryDryingPreference']);

function requireAuthority(value: unknown, message: string): asserts value {
  if (!value) throw new V2AuthorityError(message);
}
function observedTarget(view: V2HistoryView, op: SharedOperation, id: string, entityType: SharedOperation['entityType']): SharedOperation {
  const target = view.byId(id);
  requireAuthority(target && target.entityType === entityType && causallyPrecedes(target, op), 'Referenced fact was not observed');
  return target;
}

/** Signatures and the complete roster chain are verified before this business-authority pass. */
export function validateV2BusinessHistory(replica: SharedReplica, archive: readonly VerifiedSharedRoster[], migration?: VerifiedLegacyMigration): void {
  const result = assessV2BusinessHistory(replica, archive, migration);
  if (result.rejected.length) throw result.rejected[0].error;
}

export class V2AwaitingReceiptError extends Error { readonly code = 'sharing/v2-awaiting-receipt'; }
export class V2ReceiptCausalityError extends Error { readonly code = 'sharing/v2-receipt-causality'; }
export interface V2RejectedOperation { operationId: string; kind: 'unauthorized' | 'conflict' | 'unconfirmed'; error: Error }
export interface V2ReceiptEvidence {
  receipts: ReadonlyMap<string, V2ServerReceipt>;
  facts: ReadonlyMap<string, AuthenticatedSharedOperation>;
  pendingLocalIds: ReadonlySet<string>;
}
export function assessV2BusinessHistory(replica: SharedReplica, archive: readonly VerifiedSharedRoster[], migration?: VerifiedLegacyMigration,
  evidence?: V2ReceiptEvidence) {
  const pending = new Set(replica.pendingOperationIds); const rejected: V2RejectedOperation[] = [];
  const provisionalOperationIds: string[] = [];
  const receiptEpochs = new Map<string, VerifiedSharedRoster>();
  const unconfirmedFrontier = new Map<string, number>();
  const dots = new Map(replica.operations.map((op) => [`${op.authorDeviceId}:${op.deviceSequence}`, op]));
  const { view, accept } = createV2AuthorityIndex(replica.groupId);
  const ready = replica.operations.filter((op) => !pending.has(op.operationId))
    .sort((a, b) => a.logicalClock - b.logicalClock || compareOperationIds(a.operationId, b.operationId));
  for (const op of ready) {
    try {
      if (evidence && op.schemaVersion === 2) {
        const receipt = evidence.receipts.get(op.operationId);
        if (receipt) {
          const fact = evidence.facts.get(op.operationId); if (!fact) throw new Error('Missing receipt author proof');
          const receivedEpoch = bindV2ServerReceipt(receipt, fact, archive);
          receiptEpochs.set(op.operationId, receivedEpoch);
          for (const [device, count] of Object.entries(op.context)) {
            if (count <= (migration?.frontier[device] ?? 0)) continue;
            const ancestor = dots.get(`${device}:${count}`); const prior = ancestor && evidence.receipts.get(ancestor.operationId);
            if (!prior) throw new V2AwaitingReceiptError('Fetch the observed fact receipt before applying its descendant');
            if (prior.uploadSequence >= receipt.uploadSequence) throw new V2ReceiptCausalityError('A future server event cannot retroactively establish observed authority');
          }
          authorizeV2Operation(view, archive, op, migration, undefined, receiptEpochs); authorizeV2Operation(view, archive, op, migration, receivedEpoch, receiptEpochs);
        } else if (evidence.pendingLocalIds.has(op.operationId)) {
          authorizeV2Operation(view, archive, op, migration, undefined, receiptEpochs);
          authorizeV2Operation(view, archive, op, migration, archive.at(-1), receiptEpochs); provisionalOperationIds.push(op.operationId);
        } else throw new V2AwaitingReceiptError('Fetch the immutable receipt before applying this received fact');
      } else authorizeV2Operation(view, archive, op, migration);
      accept(op);
    } catch (error) {
      const awaitingAncestor = [...unconfirmedFrontier].some(([device, sequence]) => (op.context[device] ?? 0) >= sequence);
      const kind = error instanceof V2AwaitingReceiptError || awaitingAncestor ? 'unconfirmed' : error instanceof V2HistoryConflictError ? 'conflict' : 'unauthorized';
      if (kind === 'unconfirmed') unconfirmedFrontier.set(op.authorDeviceId, Math.min(unconfirmedFrontier.get(op.authorDeviceId) ?? op.deviceSequence, op.deviceSequence));
      rejected.push({ operationId: op.operationId, kind, error: awaitingAncestor ? new V2AwaitingReceiptError('Fetch the prior immutable receipts before applying this fact')
        : error instanceof Error ? error : new Error('Invalid business authority') });
    }
  }
  return { view, rejected, provisionalOperationIds, receiptEpochs: receiptEpochs as ReadonlyMap<string, VerifiedSharedRoster> };
}

export function validateV2DeliveredAuthority(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], fact: AuthenticatedSharedOperation,
  receipt: V2ServerReceipt, migration?: VerifiedLegacyMigration, requestEpochs?: ReadonlyMap<string, VerifiedSharedRoster>): void {
  const receivedEpoch = bindV2ServerReceipt(receipt, fact, archive);
  if (fact.operation.entityType === 'requestDecision' && !requestEpochs?.has(fact.operation.payload.requestId as string)) {
    throw new V2AwaitingReceiptError('The request delivery epoch is required before validating its decision');
  }
  authorizeV2Operation(view, archive, fact.operation, migration, undefined, requestEpochs);
  authorizeV2Operation(view, archive, fact.operation, migration, receivedEpoch, requestEpochs);
}

function authorizeV2Operation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, migration?: VerifiedLegacyMigration,
  receivedEpoch?: VerifiedSharedRoster, requestEpochs?: ReadonlyMap<string, VerifiedSharedRoster>): void {
  const originalEpoch = rosterAtOperation(archive, op); const epoch = receivedEpoch ?? originalEpoch; const admin = epoch.body.ownerUserId === op.authorUserId;
  sharedAuthorIdentity(originalEpoch, op.authorUserId, op.authorDeviceId, op.keyVersion);
  if (receivedEpoch) sharedAuthorIdentity(receivedEpoch, op.authorUserId, op.authorDeviceId, op.keyVersion);
  requireAuthority(originalEpoch.body.schemaVersion === op.schemaVersion, 'Operation does not match its original protocol epoch');
  if (op.schemaVersion === 1) {
    requireAuthority(migration && op.deviceSequence <= (migration.frontier[op.authorDeviceId] ?? 0), 'Legacy operation is outside the verified migration checkpoint');
    return;
  }
  const memberIds = epoch.body.members.map((member) => member.userId);
  const member = (id: string) => requireAuthority(memberIds.includes(id), 'Target is not an approved member');
  const adminOnly = () => requireAuthority(admin, 'This common setting requires the administrator');
  if (['groupPolicy', 'settings', 'baseline', 'dependency'].includes(op.entityType)) {
    adminOnly(); if (op.entityType === 'settings') requireAuthority(op.entityId === 'settings', 'Shared settings must use their singleton ID'); return;
  }
  if (op.entityType === 'chore') {
    if (op.operationType !== 'patch' || Object.keys(op.payload).some((field) => CHORE_COMMON_FIELDS.has(field)
      && !(field === 'enabled' && op.payload.enabled === false && !view.field('chore', op.entityId, '$alive', op)))) adminOnly();
    return;
  }
  if (op.entityType === 'member') {
    requireAuthority(op.entityId === op.authorUserId && (!('userId' in op.payload) || op.payload.userId === op.authorUserId), 'A profile cannot impersonate another member'); return;
  }
  if (op.entityType === 'assignment') throw new V2AuthorityError('V2 assignments require an explicit occurrence scope');
  if (['waste', 'wasteVisibility', 'appliance'].includes(op.entityType)) return;
  if (op.entityType === 'migration') {
    adminOnly(); requireAuthority(migration && canonicalJson(op.payload.legacyFrontier) === canonicalJson(migration.frontier)
      && op.payload.sourceSnapshotDigest === migration.sourceSnapshotDigest, 'Migration must bind the verified source checkpoint'); return;
  }
  if (op.entityType === 'chorePolicy') {
    adminOnly(); requireAuthority(view.field('chore', op.entityId, '$alive', op)?.value === true, 'Configure an existing shared chore');
    const configuration = op.payload.configuration as unknown as SharedChoreConfiguration;
    configuration.policy.assignment.memberIds.forEach(member);
    const previous = view.observed(view.topic('chorePolicy', op.entityId), op);
    const maximum = previous.reduce((value, fact) => Math.max(value, (fact.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion), 0);
    requireAuthority(configuration.ruleVersion === maximum + 1, 'Common rule revisions must advance explicitly'); return;
  }
  if (op.entityType === 'datePermission') {
    adminOnly(); member(op.payload.userId as string);
    requireAuthority(op.entityId === v2DatePermissionId(op.groupId, op.payload.choreId as string, op.payload.userId as string), 'Grant ID must bind its chore and member');
    requireAuthority(view.field('chore', op.payload.choreId as string, '$alive', op)?.value === true, 'Cannot grant rights for an unknown chore'); return;
  }
  if (op.entityType === 'completion' && op.operationType === 'undo') {
    const target = observedTarget(view, op, op.payload.targetOperationId as string, 'completion');
    requireAuthority(target.operationType === 'complete' && target.entityId === op.entityId
      && mayUndoCompletion(op.authorUserId, target.authorUserId, epoch.body.ownerUserId, memberIds), 'Only the recorder or administrator may undo this completion'); return;
  }
  if (op.entityType === 'completionApproval') {
    adminOnly(); const target = observedTarget(view, op, op.payload.completionOperationId as string, 'completion');
    requireAuthority(target.operationType === 'complete', 'Approval must reference an actual completion fact'); return;
  }
  if (op.entityType === 'requestDecision') {
    const request = observedTarget(view, op, op.payload.requestId as string, 'changeRequest');
    const context = dateContext(view, archive, request, undefined, undefined, requestEpochs?.get(request.operationId));
    if (op.payload.decision === 'acceptCounteroffer') {
      const proposed = observedTarget(view, op, op.payload.referenceDecisionId as string, 'requestDecision');
      const recipients = context.permission.kind === 'approvalRequired' && context.permission.approver === 'assignee'
        ? context.assigneeIds : [request.authorUserId];
      requireAuthority(recipients.includes(op.authorUserId) && proposed.payload.requestId === request.operationId
        && proposed.payload.decision === 'counteroffer', 'Only the affected consenting member may accept that administrator counteroffer');
    } else if (op.payload.decision === 'counteroffer') adminOnly();
    else {
      const permission = context.permission;
      requireAuthority(admin && !(permission.kind === 'approvalRequired' && permission.approver === 'assignee')
        || permission.kind === 'approvalRequired' && permission.approver === 'assignee' && context.assigneeIds.includes(op.authorUserId), 'Decision requires the designated approver');
    }
    if (op.payload.target !== null) {
      const target = validateDesignationTarget(context.mode, op.payload.target as unknown as DateTarget);
      requireAuthority(!fixedConflictAtOperation(view, archive, op, target, context.assigneeIds,
        { occurrenceId: context.frame.id, subjectUserId: request.payload.subjectUserId as string | null }), 'Counteroffer conflicts with a fixed shared assignment');
    }
    return;
  }
  if (op.entityType === 'designationCancel') {
    for (const id of op.payload.targetOperationIds as string[]) {
      const target = observedTarget(view, op, id, 'designation'); const rule = target.payload.configuration as unknown as ManualRule;
      requireAuthority(admin || target.authorUserId === op.authorUserId && !rule.adminLocked && !rule.strict, 'A locked designation must be changed through a request');
      const context = dateContext(view, archive, op, rule, { precision: 'date', date: rule.referenceAnchorDate }, receivedEpoch);
      requireAuthority(context.permission.kind === 'allowed' && !context.permission.needsRequest, 'Cancelling this designation requires consent');
    }
    return;
  }
  const payload = op.payload;
  const rule = op.entityType === 'designation' ? payload.configuration as unknown as ManualRule : null;
  const choreId = rule?.choreId ?? payload.choreId as string;
  const anchorDate = rule?.referenceAnchorDate ?? (payload.anchorDate ?? payload.fromAnchorDate) as LocalDate;
  const ruleVersion = rule?.ruleVersion ?? (op.entityType === 'completion' || op.entityType === 'assignmentRule' ? payload.ruleVersion as number : undefined);
  const frame = frameAtOperation(view, archive, op, choreId, anchorDate, ruleVersion);
  const occurrenceId = op.entityType === 'completion' ? v2SubjectOccurrenceId(frame.frame.id, payload.subjectUserId as string | null) : frame.frame.id;
  if (!rule) requireAuthority((payload.occurrenceId ?? payload.fromOccurrenceId ?? op.entityId) === occurrenceId, 'Operation belongs to another common occurrence');
  if (op.entityType === 'assignmentRule') { adminOnly(); (payload.memberIds as string[]).forEach(member); return; }
  if (op.entityType === 'completion') {
    member(payload.completedByMemberId as string);
    requireAuthority(frame.config.policy.completion === 'one' ? payload.subjectUserId === null : frame.subjectUserIds.includes(payload.subjectUserId as string), 'Completion subject does not belong to this chore');
    const expected = frame.config.policy.completion === 'perMember' ? [payload.subjectUserId as string] : frame.assigneeIds;
    requireAuthority(canonicalJson([...(payload.originalAssigneeIds as string[])].sort()) === canonicalJson([...expected].sort()), 'Original assignees must match the observed common state');
    requireAuthority(admin || payload.completedByMemberId === op.authorUserId || expected.includes(op.authorUserId), 'A member cannot record work as another person');
    // Disallowed substitutions remain real reports awaiting approval; they are not accepted completions.
    groupPolicyAt(view, op); return;
  }
  if (op.entityType === 'claim' || op.entityType === 'claimRelease' || op.entityType === 'claimResolution') {
    requireAuthority(frame.config.policy.completion === 'one' && frame.configuredAssignees.filter((uid) => memberIds.includes(uid)).length === 0, 'Only an unassigned common chore can be claimed');
    if (op.entityType === 'claim') requireAuthority(!frame.assigneeIds.length || frame.assigneeIds.every((uid) => uid === op.authorUserId), 'Another assignee was already observed');
    if (op.entityType === 'claimRelease') {
      for (const id of payload.targetOperationIds as string[]) {
        const target = observedTarget(view, op, id, 'claim'); requireAuthority(target.authorUserId === op.authorUserId && target.payload.occurrenceId === occurrenceId, 'Cannot release another claim');
      }
      requireAuthority(!frame.assignmentFixed || !frame.assigneeIds.includes(op.authorUserId), 'A fixed assignment needs a change request');
    }
    if (op.entityType === 'claimResolution') {
      adminOnly(); (payload.assigneeIds as string[]).forEach(member);
      const facts = [...view.observed(view.forOccurrence(occurrenceId), op), op];
      deriveClaims(occurrenceId, { activeMemberIds: memberIds,
        claims: facts.filter((fact) => fact.entityType === 'claim').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimFact),
        releases: facts.filter((fact) => fact.entityType === 'claimRelease').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimRelease),
        resolutions: facts.filter((fact) => fact.entityType === 'claimResolution').map((fact) => ({ ...fact, ...fact.payload }) as unknown as ClaimResolution) });
    }
    return;
  }
  if (op.entityType === 'designation' || op.entityType === 'changeRequest') {
    if (rule?.adminLocked) adminOnly();
    const selector = rule?.selector ?? op.payload.selector as unknown as ManualRule['selector'];
    requireAuthority(selector.scope === 'once' ? selector.occurrenceId === frame.frame.id && selector.anchorDate === frame.frame.anchorDate
      : selector.scope === 'period' ? selector.range.from <= anchorDate && (selector.range.through === null || anchorDate <= selector.range.through) : selector.from <= anchorDate,
    'Date rule must include its reference occurrence');
    const context = dateContext(view, archive, op, rule ?? undefined, undefined, receivedEpoch);
    if (rule) requireAuthority(rule.timeZoneAtCreation === context.zone, 'Designation must bind the group timezone observed by its author');
    if (!rule && context.proposedOptions.adminLocked && !context.originalRule?.adminLocked) adminOnly();
    requireAuthority(context.permission.kind !== 'denied', 'This date change is forbidden');
    if (rule) requireAuthority(context.permission.kind === 'allowed' && !context.permission.needsRequest, 'This date change requires a signed request and consent');
    return;
  }
  throw new V2AuthorityError('Unsupported v2 business operation');
}

export function dateChangeContextAtOperation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, receivedEpoch?: VerifiedSharedRoster) {
  return dateContext(view, archive, op, undefined, undefined, receivedEpoch);
}
function dateContext(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], op: SharedOperation, rule?: ManualRule, proposedOverride?: DateTarget,
  receivedEpoch?: VerifiedSharedRoster) {
  const choreId = rule?.choreId ?? op.payload.choreId as string; const anchorDate = rule?.referenceAnchorDate ?? op.payload.anchorDate as LocalDate;
  const context = frameAtOperation(view, archive, op, choreId, anchorDate, rule?.ruleVersion);
  const subject = rule ? rule.subjectUserId : op.payload.subjectUserId as string | null;
  requireAuthority(context.config.policy.completion === 'one' ? subject === null : context.subjectUserIds.includes(subject as string), 'Date subject does not belong to the chore');
  const epoch = receivedEpoch ?? rosterAtOperation(archive, op); const policy = groupPolicyAt(view, op);
  const zone = view.field('settings', 'settings', 'timeZone', op)?.value;
  requireAuthority(typeof zone === 'string', 'Missing shared timezone');
  const cancellations = new Set(view.observed(view.ofType('designationCancel'), op).flatMap((fact) => fact.payload.targetOperationIds as string[]));
  const rules = view.observed(view.ofType('designation'), op).filter((fact) => !cancellations.has(fact.operationId))
    .map((fact) => ({ ...fact, rule: fact.payload.configuration as unknown as ManualRule }) as ManualRuleFact);
  const current = selectManualRule(rules, context.frame, subject, zone);
  requireAuthority(current.kind !== 'conflict', 'Resolve concurrent dates before another change');
  const originalRule = current.kind === 'selected' ? current.fact.rule : null;
  const materialized = originalRule ? materializeRuleTarget(originalRule, context.frame, zone) : null;
  requireAuthority(!materialized || materialized.kind === 'target', 'Recurrence or timezone change requires confirmation before changing the date');
  const original = materialized?.kind === 'target' ? materialized.target : { precision: 'date' as const, date: anchorDate };
  const proposed = proposedOverride ?? rule?.target ?? op.payload.proposed as unknown as DateTarget;
  const mode: DesignationMode = proposedOverride ? 'day' : rule?.mode ?? op.payload.proposedMode as DesignationMode;
  const proposedOptions: DesignationOptions = op.entityType === 'designationCancel' ? { strict: false, adminLocked: false, forbidEarlier: false }
    : rule ? { strict: rule.strict, adminLocked: rule.adminLocked, forbidEarlier: rule.forbidEarlier } : op.payload.proposedOptions as unknown as DesignationOptions;
  if (!proposedOverride) validateDesignationTarget(mode, proposed);
  if (op.entityType === 'changeRequest') {
    requireAuthority(canonicalJson(normalizeDateTarget(op.payload.original as unknown as DateTarget)) === canonicalJson(normalizeDateTarget(original))
      && op.payload.originalDesignationId === (current.kind === 'selected' ? current.fact.operationId : null), 'Request must reference the formal date observed by its author');
  }
  const assigneeIds = subject === null ? context.assigneeIds : [subject]; const date = targetCivilDate(proposed, zone);
  const grants = view.observed(view.ofType('datePermission'), op).map((fact) => ({ ...fact, ...fact.payload }) as unknown as DatePermissionFact);
  let permission: DateChangePermission = evaluateDateChangePermission({ actorUserId: op.authorUserId, adminUserId: epoch.body.ownerUserId,
      activeMemberIds: epoch.body.members.map((member) => member.userId), choreId, assigneeIds, policy, grants,
      movingEarlier: targetReferenceTime(proposed, zone) < targetReferenceTime(original, zone), beforeWindow: date < context.frame.windowStart,
      afterWindow: date > context.frame.windowEnd, adminLocked: Boolean(originalRule?.adminLocked), strict: Boolean(originalRule?.strict),
      forbidEarlier: Boolean(originalRule?.forbidEarlier),
      fixedConflict: fixedConflictAtOperation(view, archive, op, proposed, assigneeIds, { occurrenceId: context.frame.id, subjectUserId: subject }), operation: op });
  const weakensInstruction = originalRule && (originalRule.adminLocked && !proposedOptions.adminLocked
    || originalRule.strict && !proposedOptions.strict || originalRule.forbidEarlier && !proposedOptions.forbidEarlier
    || originalRule.adminLocked && mode !== originalRule.mode);
  if (permission.kind !== 'denied' && op.authorUserId !== epoch.body.ownerUserId && weakensInstruction) {
    permission = { kind: 'approvalRequired', approver: 'admin', reason: originalRule.adminLocked ? 'fixed' : 'strict' };
  }
  return { ...context, assigneeIds, mode, original, proposed, proposedOptions, originalRule, zone, permission };
}
