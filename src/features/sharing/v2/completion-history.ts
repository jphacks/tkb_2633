import { compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { V2HistoryView } from './history-view.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import type { GroupPolicy, RecordedInstruction } from './model.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { instantMilliseconds } from './date-target.ts';
import { fulfillmentAt } from './completion-state.ts';
import { v2OccurrenceId } from './occurrence-id.ts';

export interface V2CompletionRecord {
  operationId: string; occurrenceId: string; subjectOccurrenceId: string; choreId: string; anchorDate: LocalDate;
  subjectUserId: string | null; originalAssigneeIds: string[]; performerUserId: string; recorderUserId: string;
  performedAt: string; recordedAt: string; active: boolean; outcome: 'completed' | 'incomplete';
  acceptance: 'accepted' | 'pending' | 'rejected'; approvalConflictIds: string[];
  performedTimeConfirmed: boolean; instruction: RecordedInstruction | null;
  fulfillment: 'unknown' | 'notApplicable' | 'unconfirmed' | 'fulfilled' | 'earlier' | 'later';
  strictInstructionFulfilled: boolean | null;
}
/** Facts remain immutable. Ownership/policy changes cannot retroactively change the original work report. */
export function v2CompletionHistory(view: V2HistoryView, at: SharedOperation, receipts: ReadonlyMap<string, V2ServerReceipt>): V2CompletionRecord[] {
  const complete = view.observed(view.ofType('completion'), at);
  const undone = new Set(complete.filter((op) => op.operationType === 'undo').map((op) => op.payload.targetOperationId as string));
  const approvals = new Map<string, SharedOperation[]>();
  for (const op of view.observed(view.ofType('completionApproval'), at)) {
    const id = op.payload.completionOperationId as string; const list = approvals.get(id) ?? []; list.push(op); approvals.set(id, list);
  }
  return complete.filter((op) => op.operationType === 'complete' && op.schemaVersion === 2).map((op): V2CompletionRecord => {
    const data = op.payload; const assignees = data.originalAssigneeIds as string[]; const performer = data.completedByMemberId as string;
    const policy = view.field('groupPolicy', 'policy', 'configuration', op)?.value as unknown as GroupPolicy | undefined;
    if (!policy) throw new Error('Missing historical completion policy');
    const substituted = assignees.length > 0 && !assignees.includes(performer);
    const decisions = maximalCausalFacts(approvals.get(op.operationId) ?? []);
    const contradictory = new Set(decisions.map((decision) => decision.payload.decision)).size > 1;
    const acceptance = !substituted || policy.allowSubstitution ? 'accepted' : !decisions.length || contradictory ? 'pending'
      : decisions[0].payload.decision === 'approve' ? 'accepted' : 'rejected';
    const performedAt = data.completedAt as string; const received = receipts.get(op.operationId);
    const instruction = data.recordedInstruction as unknown as RecordedInstruction | undefined;
    const fulfillment = !instruction ? 'unknown' : instruction.kind === 'automatic' ? 'notApplicable' : instruction.kind === 'unconfirmed' ? 'unconfirmed'
      : fulfillmentAt(performedAt, instruction, instruction.timeZone);
    return { operationId: op.operationId, occurrenceId: v2OccurrenceId(op.groupId, data.choreId as string, data.anchorDate as LocalDate), subjectOccurrenceId: op.entityId,
      choreId: data.choreId as string, anchorDate: data.anchorDate as LocalDate, subjectUserId: data.subjectUserId as string | null,
      originalAssigneeIds: [...assignees].sort(compareOperationIds), performerUserId: performer, recorderUserId: op.authorUserId,
      performedAt, recordedAt: op.recordedAt!, active: !undone.has(op.operationId), outcome: data.outcome as 'completed' | 'incomplete', acceptance,
      approvalConflictIds: contradictory ? decisions.map((decision) => decision.operationId) : [],
      performedTimeConfirmed: Boolean(received && instantMilliseconds(performedAt) <= received.receivedAtMs), instruction: instruction ?? null, fulfillment,
      strictInstructionFulfilled: instruction?.kind === 'designated' ? !instruction.strict || fulfillment === 'fulfilled' : instruction?.kind === 'automatic' ? true : null };
  }).sort((a, b) => instantMilliseconds(a.performedAt) - instantMilliseconds(b.performedAt) || compareOperationIds(a.operationId, b.operationId));
}
