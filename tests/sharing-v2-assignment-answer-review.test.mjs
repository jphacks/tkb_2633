import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionFixture, ref, range } from './helpers/sharing-v2-decision-fixture.mjs';
import { groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { v2AssignmentDecisionReview, v2DecisionReviews } from '../src/features/sharing/v2/decision-review.ts';

test('v2 assignment answers report a stale displayed answer set before applying a changed terminal-state shortcut', async () => {
  const f = await decisionFixture({ fixed: true, secondOwner: true });
  try {
    await f.a.actions.assign(ref, ['member'], 'this', true); await f.deliver(f.owner, [f.owner, f.member, f.owner2]);
    const [request] = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'this', scope: 'once', fixed: false });
    await f.deliver(f.member, [f.owner, f.member, f.owner2]);
    await f.c.actions.answerAssignment(request.operationId, 'reject'); await f.deliver(f.owner2, [f.owner]);
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.answerAssignment(request.operationId, 'approve', { expectedDecisionIds: [] }), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
  } finally { f.close(); }
});

test('v2 a displayed assignment review becomes stale when its fixed date changes and a fresh review can still approve', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.assign(ref, ['member'], 'this', true); await f.deliver(f.owner);
    const [request] = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'this', scope: 'once', fixed: false }); await f.deliver(f.member);
    const old = (await f.a.readModel(range)).assignmentReviews[0]; assert.equal(old.canVote, true);
    const interval = { precision: 'interval', start: '2026-10-27T12:00:00.000Z', end: '2026-10-27T12:30:00.000Z' };
    await f.a.actions.changeDate(ref, { mode: 'fixed', target: interval });
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.answerAssignment(request.operationId, 'approve', { expectedReviewRevision: old.revision }), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    const current = (await f.a.readModel(range)).assignmentReviews[0]; assert.notEqual(old.revision, current.revision);
    await f.a.actions.answerAssignment(request.operationId, 'approve', { expectedReviewRevision: current.revision });
    assert.equal((await f.a.readModel(range)).assignmentReviews[0].pendingAnswer, true);
    await f.deliver(f.owner); assert.equal((await f.b.readModel(range)).assignmentRequests[0].kind, 'approved');
  } finally { f.close(); }
});

test('v2 combined date and assignment reviews share one source index and match their single-request guards', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.assign(ref, ['member'], 'this', true); await f.deliver(f.owner);
    const [request] = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'this', scope: 'once', fixed: false }); await f.deliver(f.member);
    const source = await f.owner.repository.readState(); let traversals = 0; const view = Object.create(source.assessment.view);
    Object.defineProperty(view, 'ready', { get() { traversals++; return source.assessment.view.ready; } });
    const state = { ...source, assessment: { ...source.assessment, view } }; const reviews = v2DecisionReviews(state, 'owner');
    assert.equal(reviews.date.length, 1); assert.equal(reviews.assignment.length, 1); assert.ok(traversals <= 4);
    assert.deepEqual(reviews.assignment[0], v2AssignmentDecisionReview(source, request.operationId, 'owner'));
    assert.equal(v2AssignmentDecisionReview(source, request.operationId, 'member').canVote, false);
  } finally { f.close(); }
});
