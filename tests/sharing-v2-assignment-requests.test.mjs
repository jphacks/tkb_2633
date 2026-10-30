import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, anchorDate } from './helpers/sharing-v2-plan-fixture.mjs';
import { frameAtOperation } from '../src/features/sharing/v2/authority-context.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { v2AssignmentRequestReference, approvedV2AssignmentId } from '../src/features/sharing/v2/assignment-state.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
const accepted = (f) => assert.deepEqual(f.state().assessment.rejected.map((entry) => [entry.operationId, entry.error.message]), []);
const observed = (f) => f.facts.map((fact) => fact.operation);
function context(f, { conflict = false, facts } = {}) {
  const s = f.state(facts); const at = v2ReadPoint(s.assessment.view, f.archive.at(-1));
  return { s, at, frame: frameAtOperation(s.assessment.view, f.archive, at, 'floor', anchorDate, 1, { allowAssignmentConflict: conflict }) };
}
function request(f, { actor = 'a', memberIds = [], scope = 'once', fixed = false, observed: prior, ...options } = {}) {
  const { s, at, frame } = context(f, { facts: prior ? f.facts.filter((fact) => prior.some((op) => op.operationId === fact.operation.operationId)) : undefined });
  return f.make('assignmentRequest', { requesterUserId: actor === 'owner2' ? 'owner' : actor, choreId: 'floor', anchorDate, occurrenceId: frame.frame.id, ruleVersion: 1,
    originalMemberIds: frame.assigneeIds, originalAssignmentIds: frame.assignmentOperationIds, originalClaimOperationIds: frame.claims.activeClaimOperationIds,
    memberIds, scope, fixed, ...v2AssignmentRequestReference(s.assessment.view, at, frame.frame, frame.config.policy.completion === 'perMember' ? frame.subjectUserIds : [], s.assessment.formalRulesAt(at)) },
  { actor, ...(prior ? { observed: prior } : {}), ...options });
}
function deliver(f, operation, time = '2026-10-27T10:30:00Z') {
  const fact = f.facts.find((entry) => entry.operation.operationId === operation.operationId);
  f.receipts.set(operation.operationId, { schemaVersion: 2, groupId: operation.groupId, operationId: operation.operationId, authorUserId: operation.authorUserId,
    authorDeviceId: operation.authorDeviceId, receivedKeyVersion: f.archive.at(-1).body.keyVersion,
    uploadSequence: Math.max(...[...f.receipts.values()].map((receipt) => receipt.uploadSequence)) + 1, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: Date.parse(time) });
}
const vote = (f, req, decision = 'approve', options = {}) => f.make('assignmentDecision', { requestId: req.operationId, decision }, options);
function resolve(f, memberIds) {
  const { frame } = context(f, { conflict: true });
  return f.make('assignmentRule', { choreId: 'floor', memberIds, fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'once', fixed: false, ruleVersion: 1,
    basisRuleIds: frame.assignmentOperationIds, ...(frame.assignmentReviewRequestIds.length ? { reviewedAssignmentRequestIds: frame.assignmentReviewRequestIds } : {}) });
}

test('v2 fixed claim release remains a request until both immutable receipts arrive and then clears the old claim without resurrecting it', async () => {
  const f = await fixture(); const claim = f.make('claim', { choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), userId: 'a' }, { actor: 'a' });
  f.make('claimResolution', { choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), claimOperationIds: [claim.operationId], assigneeIds: ['a'], fixed: true });
  const req = request(f, { delivered: false }); accepted(f);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'pendingDelivery'); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
  deliver(f, req, '2026-10-27T10:05:00Z'); const answer = vote(f, req, 'approve', { delivered: false }); accepted(f);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'awaiting'); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
  deliver(f, answer); accepted(f); assert.equal(f.state().assessment.assignmentRequests[0].kind, 'approved');
  assert.deepEqual(f.plan().occurrences[0].assigneeIds, []); assert.equal(f.plan().occurrences[0].assignmentFixed, false);
  const next = f.make('claim', { choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), userId: 'b' }, { actor: 'b', delivered: false }); deliver(f, next, '2026-10-27T10:35:00Z'); accepted(f);
  assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['b']);
});

test('v2 a late offline assignment approval stays in the audit and cannot clear its original fixed assignee', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f);
  const answer = vote(f, req, 'approve', { receivedAt: '2026-10-27T11:00:00.001Z', recordedAt: '2026-10-27T10:01:00Z' }); accepted(f);
  const state = f.state().assessment.assignmentRequests[0]; assert.equal(state.kind, 'expired'); assert.ok(state.decisions.some((entry) => entry.operationId === answer.operationId && entry.kind === 'late'));
  assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
});

test('v2 assignment requests and votes validate affected membership, the original assignment, schedule reference and administrator authority', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  const foreign = request(f, { actor: 'b' }); assert.ok(f.state().assessment.rejected.some((entry) => entry.operationId === foreign.operationId));
  const req = request(f); const answer = vote(f, req, 'approve', { actor: 'b' });
  assert.ok(f.state().assessment.rejected.some((entry) => entry.operationId === answer.operationId)); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
  const fake = f.make('assignmentRequest', { ...req.payload, reference: { precision: 'date', date: '2026-11-27' } }, { actor: 'a' });
  assert.ok(f.state().assessment.rejected.some((entry) => entry.operationId === fake.operationId));
});

test('v2 a direct assignment that saw only a pending request cannot silently replace its later concurrent approval', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f); const base = observed(f);
  f.make('assignmentRule', { choreId: 'floor', memberIds: ['b'], fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'once', fixed: false, ruleVersion: 1, basisRuleIds: [] });
  vote(f, req, 'approve', { actor: 'owner2', observed: base }); accepted(f);
  assert.ok(f.plan().occurrences[0].assignmentConflictIds.length); assert.ok(f.plan().issues.some((issue) => issue.kind === 'assignmentNeedsReview'));
  resolve(f, ['b']); accepted(f); assert.deepEqual(f.plan().occurrences[0].assignmentConflictIds, []); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['b']);
});

test('v2 equivalent concurrent assignment approvals retain one stable rule and either confirmation can authorize its later replacement', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f, { memberIds: ['b'] }); const base = observed(f);
  vote(f, req); const withFirst = observed(f); vote(f, req, 'approve', { actor: 'owner2', observed: base }); accepted(f);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'approved'); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['b']);
  f.make('assignmentRule', { choreId: 'floor', memberIds: ['a'], fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'once', fixed: true, ruleVersion: 1,
    basisRuleIds: [approvedV2AssignmentId(req)] }, { observed: withFirst }); accepted(f);
  assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']); assert.deepEqual(f.plan().occurrences[0].assignmentConflictIds, []);
});

test('v2 contradictory concurrent assignment votes require explicit review and preserve the same result in reverse receive order', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f, { memberIds: ['b'] }); const base = observed(f);
  vote(f, req); vote(f, req, 'reject', { actor: 'owner2', observed: base }); accepted(f);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'conflict'); assert.ok(f.plan().occurrences[0].assignmentConflictIds.length);
  assert.deepEqual(f.plan(), f.plan({}, [...f.facts].reverse())); resolve(f, ['a']); accepted(f);
  assert.deepEqual(f.plan().occurrences[0].assignmentConflictIds, []); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'conflict');
});

test('v2 assignment approval after work was completed cannot reopen that round for a new per-member subject', async () => {
  const f = await fixture({ configuration: { policy: { completion: 'perMember', assignment: { mode: 'selected', memberIds: ['a'] } } } });
  const req = request(f, { memberIds: ['b'], scope: 'from' }); const work = f.complete({ subject: 'a' }); accepted(f);
  vote(f, req); accepted(f); const plan = f.plan(); assert.equal(plan.occurrences[0].completed, true);
  assert.deepEqual(plan.occurrences[0].subjects.filter((subject) => subject.required).map((subject) => subject.subjectUserId), ['a']);
  assert.deepEqual(plan.occurrences[1].subjectUserIds, ['b']); assert.equal(plan.history[0].operationId, work.operationId);
});

test('v2 knowing a pending assignment approval does not mean observing its receipt and cannot retroactively invalidate work recorded under the original assignee', async () => {
  for (const perMember of [false, true]) {
    const f = await fixture({ configuration: { policy: { completion: perMember ? 'perMember' : 'one', assignment: { mode: 'selected', memberIds: ['a'] } } } });
    const req = request(f, { memberIds: ['b'], scope: 'from' }); const answer = vote(f, req, 'approve', { delivered: false });
    const work = f.complete({ subject: perMember ? 'a' : null, delivered: false }); accepted(f);
    assert.equal(work.receiptContext[answer.authorDeviceId] < answer.deviceSequence, true);
    assert.deepEqual(work.payload.originalAssigneeIds, ['a']);
    deliver(f, answer); deliver(f, work, '2026-10-27T10:35:00Z'); accepted(f);
    const plan = f.plan(); const record = plan.history.find((entry) => entry.operationId === work.operationId);
    assert.equal(record.active, true); assert.deepEqual(record.originalAssigneeIds, ['a']);
    assert.equal(plan.occurrences[0].completed, true); assert.deepEqual(plan.occurrences[1].assigneeIds, ['b']);
  }
});

test('v2 knowing an automatic date request before its receipt cannot retroactively replace the instruction captured by a completion', async () => {
  const f = await fixture();
  const req = f.make('changeRequest', { requesterUserId: 'owner', choreId: 'floor', anchorDate, occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: null, original: { precision: 'date', date: anchorDate }, proposed: { precision: 'date', date: '2026-10-31' }, proposedMode: 'day',
    proposedOptions: { strict: true, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate }, extensionScope: 'future' }, { delivered: false });
  const work = f.complete({ delivered: false }); accepted(f); assert.equal(work.payload.recordedInstruction.kind, 'automatic');
  deliver(f, req, '2026-10-27T10:10:00Z'); deliver(f, work, '2026-10-27T10:11:00Z'); accepted(f);
  const record = f.plan().history.find((entry) => entry.operationId === work.operationId); assert.equal(record.instruction.kind, 'automatic'); assert.equal(record.fulfillment, 'notApplicable');
});

test('v2 an approved old-cadence assignment unseen by a concurrent configuration remains reviewable through later unrelated edits until explicitly mapped', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const base = observed(f); const req = request(f, { memberIds: ['b'], scope: 'from' }); const withRequest = observed(f);
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, effectiveFrom: anchorDate, intervalDays: 3 } }, { entityId: 'floor', observed: base });
  vote(f, req, 'approve', { actor: 'owner2', observed: withRequest }); accepted(f);
  let plan = f.plan(); assert.ok(plan.occurrences[0].assignmentConflictIds.includes(approvedV2AssignmentId(req))); assert.equal(plan.occurrences[0].needsAssignment, true);
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 3, effectiveFrom: anchorDate, intervalDays: 3, windowAfterDays: 4, assignmentSourceVersion: 2 } }, { entityId: 'floor' }); accepted(f);
  plan = f.plan(); assert.ok(plan.occurrences[0].assignmentConflictIds.includes(approvedV2AssignmentId(req)));
  const s = f.state(); const at = v2ReadPoint(s.assessment.view, f.archive.at(-1)); const frame = frameAtOperation(s.assessment.view, f.archive, at, 'floor', anchorDate, 3, { allowAssignmentConflict: true });
  f.make('assignmentRule', { choreId: 'floor', memberIds: ['b'], fromOccurrenceId: f.occurrence(), fromAnchorDate: anchorDate, scope: 'from', fixed: false, ruleVersion: 3, basisRuleIds: frame.assignmentOperationIds }); accepted(f);
  plan = f.plan(); assert.deepEqual(plan.occurrences[0].assignmentConflictIds, []); assert.deepEqual(plan.occurrences[0].assigneeIds, ['b']); assert.equal(plan.occurrences[1].needsAssignment, false);
});

test('v2 an administrator cannot approve an old pending assignment after intentionally replacing its cadence without inheriting its assignment source', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f, { memberIds: ['b'], scope: 'from' });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, ruleVersion: 2, effectiveFrom: anchorDate, intervalDays: 3 } }, { entityId: 'floor' }); accepted(f);
  const answer = vote(f, req); assert.ok(f.state().assessment.rejected.some((entry) => entry.operationId === answer.operationId));
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'awaiting'); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['a']);
});

test('v2 cancelling an assignment preserves its approval and real work history while preventing later approval from reviving it', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f, { memberIds: ['b'] }); vote(f, req); f.complete({ actor: 'b' }); accepted(f);
  const history = f.plan().history; const cancellation = f.make('assignmentCancel', { targetOperationIds: [req.operationId] }); accepted(f);
  assert.equal(f.state().assessment.assignmentRequests[0].kind, 'approved'); assert.equal(f.state().assessment.assignmentRequests[0].cancelled, true);
  assert.deepEqual(f.plan().history, history); assert.deepEqual(context(f).frame.assigneeIds, ['a']);
  assert.ok(f.state().assessment.view.byId(req.operationId)); assert.ok(f.state().assessment.view.byId(cancellation.operationId));
  const late = vote(f, req); assert.ok(f.state().assessment.rejected.some((entry) => entry.operationId === late.operationId));
});

test('v2 one-off assignments that no longer map to the revised cadence remain explicit review items until an administrator cancels or remaps their source', async () => {
  const f = await fixture(); const oldAnchor = '2026-11-03';
  const assignment = f.make('assignmentRule', { choreId: 'floor', memberIds: ['a'], fromOccurrenceId: f.occurrence(oldAnchor), fromAnchorDate: oldAnchor, scope: 'once', fixed: true, ruleVersion: 1 });
  f.make('chorePolicy', { configuration: { ...f.defaultConfiguration, anchorDate: '2026-10-28', intervalDays: 4, ruleVersion: 2, effectiveFrom: '2026-10-28' } }, { entityId: 'floor' }); accepted(f);
  assert.ok(f.plan().issues.some((issue) => issue.kind === 'oneOffAssignmentMappingNeedsReview' && issue.operationIds.includes(assignment.operationId)));
  f.make('assignmentCancel', { targetOperationIds: [assignment.operationId] }); accepted(f);
  assert.equal(f.plan().issues.some((issue) => issue.kind === 'oneOffAssignmentMappingNeedsReview'), false);
  assert.ok(f.state().assessment.view.byId(assignment.operationId));
});

test('v2 assignment cancellation refuses non-administrators, unrelated entity sources and unknown source IDs without changing the formal assignee', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const req = request(f, { memberIds: ['b'] }); vote(f, req); accepted(f);
  const denied = f.make('assignmentCancel', { targetOperationIds: [req.operationId] }, { actor: 'a' });
  const unrelated = f.make('assignmentCancel', { targetOperationIds: [f.facts[0].operation.operationId] });
  const missing = f.make('assignmentCancel', { targetOperationIds: ['another-group-source'] });
  const state = f.state(); assert.deepEqual(state.assessment.rejected.map((entry) => entry.operationId).sort(), [denied, unrelated, missing].map((op) => op.operationId).sort());
  assert.equal(state.assessment.assignmentRequests[0].cancelled, false); assert.deepEqual(f.plan().occurrences[0].assigneeIds, ['b']);
});
