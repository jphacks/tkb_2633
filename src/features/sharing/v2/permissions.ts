import { canonicalJson, causallyPrecedes } from '../operations.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import type { CausalStamp, GroupPolicy } from './model.ts';

export interface DatePermissionFact extends CausalStamp {
  authorUserId: string; choreId: string; userId: string; enabled: boolean;
  rights: { changeDate: boolean; changeOthers: boolean; changeBeforeWindow: boolean };
}
export interface DateChangeContext {
  actorUserId: string; adminUserId: string; activeMemberIds: readonly string[]; choreId: string;
  assigneeIds: readonly string[]; policy: GroupPolicy; grants: readonly DatePermissionFact[];
  movingEarlier: boolean; beforeWindow: boolean; afterWindow: boolean;
  adminLocked: boolean; strict: boolean; forbidEarlier: boolean; fixedConflict: boolean;
  operation?: CausalStamp;
}
export type DateChangePermission = { kind: 'allowed'; needsRequest: boolean; automaticallyApproved: boolean }
  | { kind: 'approvalRequired'; approver: 'admin' | 'assignee' | 'adminAndAssignee'; reason: 'othersAssignment' | 'fixed' | 'outsideWindow' | 'strict' }
  | { kind: 'denied'; reason: 'notMember' | 'fixedConflict' | 'permissionConflict' | 'dependency' };

export interface V2DateDecisionAudience {
  automatic: boolean;
  administratorVote: boolean;
  approvingMemberIds: string[];
  counterofferRecipientIds: string[];
}
/** The reducer, receiver and screens must use the same required-consent cohorts. */
export function v2DateDecisionAudience(permission: DateChangePermission, assigneeIds: readonly string[], requesterUserId: string): V2DateDecisionAudience {
  const memberConsent = permission.kind === 'approvalRequired' && permission.approver !== 'admin';
  return { automatic: permission.kind === 'allowed',
    administratorVote: !(permission.kind === 'approvalRequired' && permission.approver === 'assignee'),
    approvingMemberIds: memberConsent ? [...new Set(assigneeIds)].sort() : [],
    counterofferRecipientIds: memberConsent ? [...new Set(assigneeIds)].sort() : [requesterUserId] };
}

/** Grant facts have already authenticated their issuer against the signed roster at authoring. */
export function effectiveDatePermission(input: { grants: readonly DatePermissionFact[]; choreId: string; userId: string;
  delegationEnabled: boolean; operation?: CausalStamp }) {
  const empty = { changeDate: false, changeOthers: false, changeBeforeWindow: false, conflict: false };
  if (!input.delegationEnabled) return empty;
  const relevant = input.grants.filter((fact) => fact.choreId === input.choreId && fact.userId === input.userId);
  const observed = input.operation ? relevant.filter((fact) => causallyPrecedes(fact, input.operation!)) : relevant;
  const latest = maximalCausalFacts(observed);
  const concurrent = input.operation ? relevant.filter((fact) => !causallyPrecedes(fact, input.operation!) && !causallyPrecedes(input.operation!, fact)) : [];
  // Revocation concurrent with a grant cannot silently expand rights.
  if (latest.some((fact) => !fact.enabled)) return { ...empty, conflict: latest.length > 1 };
  if (concurrent.some((fact) => !fact.enabled)) return { ...empty, conflict: true };
  if (!latest.length) return empty;
  if (new Set(latest.map((fact) => canonicalJson(fact.rights))).size > 1) return { ...empty, conflict: true };
  if (concurrent.some((fact) => canonicalJson(fact.rights) !== canonicalJson(latest[0].rights))) return { ...empty, conflict: true };
  const canChange = latest.every((fact) => fact.rights.changeDate);
  return { changeDate: canChange, changeOthers: canChange && latest.every((fact) => fact.rights.changeOthers),
    changeBeforeWindow: canChange && latest.every((fact) => fact.rights.changeBeforeWindow), conflict: false };
}
export function evaluateDateChangePermission(input: DateChangeContext): DateChangePermission {
  if (!input.activeMemberIds.includes(input.actorUserId)) return { kind: 'denied', reason: 'notMember' };
  if (input.fixedConflict) return { kind: 'denied', reason: 'fixedConflict' };
  const admin = input.actorUserId === input.adminUserId;
  const owns = input.assigneeIds.includes(input.actorUserId);
  const grant = effectiveDatePermission({ grants: input.grants, choreId: input.choreId, userId: input.actorUserId,
    delegationEnabled: input.policy.delegationEnabled, operation: input.operation });
  if (!admin && !owns && grant.conflict) return { kind: 'denied', reason: 'permissionConflict' };
  if (admin) {
    if (!owns && input.assigneeIds.length && !input.policy.adminCanFixWithoutConsent) return { kind: 'approvalRequired', approver: 'assignee', reason: 'othersAssignment' };
    return { kind: 'allowed', needsRequest: false, automaticallyApproved: false };
  }
  const canAutomaticallyApprove = input.movingEarlier && input.policy.autoApproveEarlier && !input.strict && !input.forbidEarlier
    && (!input.beforeWindow || input.policy.allowBeforeWindow || grant.changeBeforeWindow) && !input.afterWindow;
  if (input.strict || input.forbidEarlier && input.movingEarlier) return { kind: 'approvalRequired', approver: 'admin', reason: 'strict' };
  if (input.beforeWindow && !input.policy.allowBeforeWindow && !grant.changeBeforeWindow || input.afterWindow && !input.policy.allowAfterWindow) {
    return { kind: 'approvalRequired', approver: 'admin', reason: 'outsideWindow' };
  }
  if (!owns && !grant.changeOthers) return { kind: 'approvalRequired', approver: input.assigneeIds.length ? 'assignee' : 'admin', reason: 'othersAssignment' };
  if (input.adminLocked) {
    return canAutomaticallyApprove ? { kind: 'allowed', needsRequest: true, automaticallyApproved: true }
      : { kind: 'approvalRequired', approver: 'admin', reason: 'fixed' };
  }
  return { kind: 'allowed', needsRequest: false, automaticallyApproved: false };
}
export function mayUndoCompletion(actorUserId: string, recorderUserId: string, adminUserId: string, activeMemberIds: readonly string[]): boolean {
  return activeMemberIds.includes(actorUserId) && (actorUserId === recorderUserId || actorUserId === adminUserId);
}
