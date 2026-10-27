import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { evaluateDateChangePermission, effectiveDatePermission, mayUndoCompletion } from '../src/features/sharing/v2/permissions.ts';
import { deriveClaims } from '../src/features/sharing/v2/claims.ts';
import { deriveOccurrenceCompletion, minimumNextExecutionDay, fulfillmentAt, showExpiredOnHome } from '../src/features/sharing/v2/completion-state.ts';

const members = ['owner', 'member-a', 'member-b', 'member-c'];
function stamp(operationId, device = operationId, context = {}) { return { operationId, authorDeviceId: device, deviceSequence: (context[device] ?? 0) + 1, context }; }
function grant(operationId, enabled = true, context = {}) {
  return { ...stamp(operationId, operationId, context), authorUserId: 'owner', choreId: 'chore-a', userId: 'member-a', enabled,
    rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } };
}
function changeContext() {
  return { actorUserId: 'member-a', adminUserId: 'owner', activeMemberIds: members, choreId: 'chore-a', assigneeIds: ['member-a'],
    policy: createGroupPolicy('family'), grants: [], movingEarlier: false, beforeWindow: false, afterWindow: false,
    adminLocked: false, strict: false, forbidEarlier: false, fixedConflict: false };
}
test('v2 delegation being enabled grants no rights until an explicit scoped grant and concurrent revocation cannot expand them', () => {
  const context = { ...changeContext(), assigneeIds: ['member-b'] };
  assert.equal(evaluateDateChangePermission(context).kind, 'approvalRequired');
  assert.equal(evaluateDateChangePermission({ ...context, grants: [grant('grant-a')] }).kind, 'allowed');
  assert.equal(evaluateDateChangePermission({ ...context, grants: [grant('grant-a')], policy: { ...context.policy, delegationEnabled: false } }).kind, 'approvalRequired');
  for (const patch of [{ choreId: 'other-chore' }, { userId: 'other-user' }]) {
    assert.equal(evaluateDateChangePermission({ ...context, grants: [{ ...grant('grant-a'), ...patch }] }).kind, 'approvalRequired');
  }
  const revoked = grant('revoke', false);
  assert.equal(evaluateDateChangePermission({ ...context, grants: [grant('grant-a'), revoked] }).reason, 'permissionConflict');
  const later = grant('grant-b', true, { 'grant-a': 1, revoke: 1 });
  assert.equal(evaluateDateChangePermission({ ...context, grants: [grant('grant-a'), revoked, later] }).kind, 'allowed');
  const unseen = effectiveDatePermission({ grants: [later], delegationEnabled: true, choreId: 'chore-a', userId: 'member-a', operation: stamp('unseen') });
  assert.equal(unseen.changeDate, false);
});
test('v2 date grants are evaluated at the action causal frontier and later grants never retroactively authorize an unobserved action', () => {
  const first = grant('first-grant'); const action = stamp('date-change', 'editing-device', { 'first-grant': 1 });
  const later = grant('later-revoke', false, { 'first-grant': 1, 'editing-device': 1 });
  const input = { grants: [first, later], delegationEnabled: true, choreId: 'chore-a', userId: 'member-a', operation: action };
  assert.equal(effectiveDatePermission(input).changeDate, true, 'a later observed revocation does not rewrite a previously authorized action');
  assert.equal(effectiveDatePermission({ ...input, operation: stamp('old-unobserved') }).changeDate, false);
  assert.equal(effectiveDatePermission({ ...input, grants: [first, grant('concurrent-revoke', false)] }).conflict, true);
});
test('v2 date permissions keep fixed, strict, outside-window and assignee-consent rules above automatic earlier approval', () => {
  const base = changeContext();
  assert.deepEqual(evaluateDateChangePermission(base), { kind: 'allowed', needsRequest: false, automaticallyApproved: false });
  assert.equal(evaluateDateChangePermission({ ...base, afterWindow: true }).reason, 'outsideWindow');
  assert.equal(evaluateDateChangePermission({ ...base, beforeWindow: true }).kind, 'allowed');
  assert.equal(evaluateDateChangePermission({ ...base, beforeWindow: true, policy: { ...base.policy, allowBeforeWindow: false } }).kind, 'approvalRequired');
  assert.deepEqual(evaluateDateChangePermission({ ...base, adminLocked: true, movingEarlier: true }), { kind: 'allowed', needsRequest: true, automaticallyApproved: true });
  assert.equal(evaluateDateChangePermission({ ...base, adminLocked: true, movingEarlier: true, strict: true }).reason, 'strict');
  assert.equal(evaluateDateChangePermission({ ...base, adminLocked: true, movingEarlier: true, forbidEarlier: true }).reason, 'strict');
  assert.equal(evaluateDateChangePermission({ ...base, adminLocked: true, fixedConflict: true }).kind, 'denied');
  assert.equal(evaluateDateChangePermission({ ...base, actorUserId: 'owner', assigneeIds: ['member-a'] }).kind, 'allowed');
  assert.equal(evaluateDateChangePermission({ ...base, actorUserId: 'owner', assigneeIds: ['member-a'], policy: createGroupPolicy('roommates') }).approver, 'assignee');
  assert.equal(evaluateDateChangePermission({ ...base, policy: createGroupPolicy('roommates'), afterWindow: true }).kind, 'allowed');
  assert.equal(evaluateDateChangePermission({ ...base, actorUserId: 'outsider' }).reason, 'notMember');
});
test('v2 administrator requirements retain third-party consent while explicit ordinary date delegation remains usable', () => {
  const base = { ...changeContext(), assigneeIds: ['member-b'], policy: { ...createGroupPolicy('roommates'), delegationEnabled: true, allowBeforeWindow: false, allowAfterWindow: false } };
  for (const grants of [[], [grant('delegated')]]) {
    for (const condition of [{ strict: true }, { adminLocked: true }, { forbidEarlier: true, movingEarlier: true }, { afterWindow: true }]) {
      const permission = evaluateDateChangePermission({ ...base, ...condition, grants });
      assert.equal(permission.kind, 'approvalRequired'); assert.equal(permission.approver, 'adminAndAssignee');
    }
    const plain = evaluateDateChangePermission({ ...base, grants }); const earlier = evaluateDateChangePermission({ ...base, grants, adminLocked: true, movingEarlier: true });
    if (grants.length) { assert.equal(plain.kind, 'allowed'); assert.deepEqual(earlier, { kind: 'allowed', needsRequest: true, automaticallyApproved: true }); }
    else { assert.equal(plain.approver, 'assignee'); assert.equal(earlier.approver, 'assignee'); }
  }
  const own = { ...base, assigneeIds: ['member-a'] };
  assert.equal(evaluateDateChangePermission({ ...own, strict: true }).approver, 'admin');
  assert.deepEqual(evaluateDateChangePermission({ ...own, adminLocked: true, movingEarlier: true }), { kind: 'allowed', needsRequest: true, automaticallyApproved: true });
});

const take = (id, userId) => ({ ...stamp(id), occurrenceId: 'occurrence-a', userId });
const claimInput = (claims, resolutions = [], releases = []) => ({ claims, resolutions, releases, activeMemberIds: members });
const choose = (id, claims, userId, fixed = false) => ({ ...stamp(id, id, Object.fromEntries(claims.map((claim) => [claim.authorDeviceId, claim.deviceSequence]))),
  occurrenceId: 'occurrence-a', claimOperationIds: claims.map((claim) => claim.operationId), assigneeIds: [userId], fixed });
test('v2 concurrent claims keep every claimant provisional regardless of arrival order or duplicate delivery', () => {
  const a = take('take-a', 'member-a'); const b = take('take-b', 'member-b');
  const expected = { kind: 'provisional', assigneeIds: ['member-a', 'member-b'], activeClaimOperationIds: ['take-a', 'take-b'] };
  for (const facts of [[a, b], [b, a], [b, structuredClone(a), a, b]]) assert.deepEqual(deriveClaims('occurrence-a', claimInput(facts)), expected);
  const resolution = choose('chosen', [a, b], 'member-a');
  assert.deepEqual(deriveClaims('occurrence-a', claimInput([b, a], [resolution])).assigneeIds, ['member-a']);
  const late = take('late-c', 'member-c');
  const unresolved = deriveClaims('occurrence-a', claimInput([late, b, a], [resolution]));
  assert.equal(unresolved.kind, 'provisional'); assert.deepEqual(unresolved.assigneeIds, ['member-a', 'member-c']);
});
test('v2 claim release targets only observed own claims and a released resolved winner does not revive losing claims', () => {
  const a = take('take-a', 'member-a'); const otherDevice = take('another-device-a', 'member-a'); const b = take('take-b', 'member-b');
  const release = { ...stamp('released', 'released', { 'take-a': 1 }), occurrenceId: 'occurrence-a', userId: 'member-a', targetOperationIds: ['take-a'] };
  assert.equal(deriveClaims('occurrence-a', claimInput([a, otherDevice], [], [release])).kind, 'claimed');
  assert.throws(() => deriveClaims('occurrence-a', claimInput([a], [], [{ ...release, userId: 'member-b' }])));
  assert.throws(() => deriveClaims('occurrence-a', claimInput([a], [], [{ ...release, context: {} }])));
  const resolution = choose('chosen', [a, b], 'member-a');
  const releaseAfter = { ...release, context: { 'take-a': 1, 'take-b': 1, chosen: 1 } };
  assert.equal(deriveClaims('occurrence-a', claimInput([a, b], [resolution], [releaseAfter])).kind, 'unassigned');
  const removed = deriveClaims('occurrence-a', { ...claimInput([a, b], [resolution]), activeMemberIds: ['owner', 'member-b'] });
  assert.equal(removed.kind, 'unassigned');
});
test('v2 fixed claim assignment cannot be unilaterally released and a concurrent release remains an explicit provisional conflict', () => {
  const a = take('take-a', 'member-a'); const b = take('take-b', 'member-b'); const resolution = choose('chosen', [a, b], 'member-a', true);
  const release = { ...stamp('released', 'released', { 'take-a': 1 }), occurrenceId: 'occurrence-a', userId: 'member-a', targetOperationIds: ['take-a'] };
  assert.equal(deriveClaims('occurrence-a', claimInput([a, b], [resolution], [release])).kind, 'provisional');
  assert.throws(() => deriveClaims('occurrence-a', claimInput([a, b], [resolution], [{ ...release, context: { ...release.context, chosen: 1, 'take-b': 1 } }])));
});

function completed(id, subjectUserId = null, overrides = {}) {
  return { ...stamp(id), occurrenceId: 'occurrence-a', subjectUserId, originalAssigneeIds: ['member-a'], performerUserId: 'member-b', recorderUserId: 'member-b',
    performedAt: '2026-10-27T09:00:00Z', recordedAt: '2026-10-27T10:00:00Z', acceptance: 'accepted', ...overrides };
}
const completionInput = (facts, policy = chorePolicyFromPreset('common')) => ({ occurrenceId: 'occurrence-a', policy, subjectUserIds: ['member-a', 'member-b'], facts, undos: [],
  authorizeUndo: (undo, target) => mayUndoCompletion(undo.authorUserId, target.recorderUserId, 'owner', members) });
test('v2 each-member completion stays independent and substitution approval is separate from the immutable work fact', () => {
  const a = completed('done-a', 'member-a'); const b = completed('done-b', 'member-b'); const policy = chorePolicyFromPreset('eachMember');
  const one = deriveOccurrenceCompletion(completionInput([a], policy));
  assert.equal(one.completed, false); assert.deepEqual(one.completedBySubject, { 'member-a': true, 'member-b': false });
  assert.equal(deriveOccurrenceCompletion(completionInput([a, b], policy)).completed, true);
  const pending = deriveOccurrenceCompletion(completionInput([completed('pending', null, { acceptance: 'pending' })]));
  assert.equal(pending.completed, false); assert.equal(pending.history.length, 1);
  assert.equal(pending.history[0].performerUserId, 'member-b'); assert.deepEqual(pending.history[0].originalAssigneeIds, ['member-a']);
});
test('v2 completion undo is recorder-or-admin, observed and targeted without removing another independent completion', () => {
  const a = completed('done-a', null, { recorderUserId: 'member-a' }); const b = completed('done-b');
  const undo = { ...stamp('undo-a', 'undo-a', { 'done-a': 1 }), targetOperationId: 'done-a', authorUserId: 'member-a' };
  const input = completionInput([a, b]);
  const state = deriveOccurrenceCompletion({ ...input, undos: [undo, structuredClone(undo)] });
  assert.equal(state.completed, true); assert.deepEqual(state.active.map((fact) => fact.operationId), ['done-b']); assert.equal(state.history.length, 2);
  assert.throws(() => deriveOccurrenceCompletion({ ...input, undos: [{ ...undo, authorUserId: 'member-c' }] }));
  assert.throws(() => deriveOccurrenceCompletion({ ...input, undos: [{ ...undo, context: {} }] }));
  assert.equal(deriveOccurrenceCompletion({ ...input, undos: [{ ...undo, authorUserId: 'owner' }] }).completed, true);
});
test('v2 common chores can finish during provisional claims and resolving assignments never erases who actually worked', () => {
  const a = take('take-a', 'member-a'); const b = take('take-b', 'member-b'); const work = completed('work');
  const before = structuredClone(work);
  assert.equal(deriveClaims('occurrence-a', claimInput([a, b])).kind, 'provisional');
  assert.equal(deriveOccurrenceCompletion(completionInput([work])).completed, true);
  deriveClaims('occurrence-a', claimInput([a, b], [choose('chosen', [a, b], 'member-a')]));
  const state = deriveOccurrenceCompletion(completionInput([work]));
  assert.equal(state.completed, true); assert.deepEqual(state.history, [before]); assert.deepEqual(work, before);
});
test('v2 short cycles suppress only the matching subject from the real execution day while daily and weekly anchors stay independent', () => {
  const a = completed('done-a', 'member-a'); const b = completed('done-b', 'member-b', { performedAt: '2026-10-29T00:00:00Z' });
  for (const [cycle, expected] of [[2, '2026-10-29'], [3, '2026-10-30'], [4, '2026-10-31'], [5, '2026-11-01'], [6, '2026-11-02']]) {
    assert.equal(minimumNextExecutionDay(cycle, [a, b], 'UTC', 'member-a'), expected);
  }
  for (const cycle of [1, 7, 30]) assert.equal(minimumNextExecutionDay(cycle, [a], 'UTC', 'member-a'), null);
  assert.equal(minimumNextExecutionDay(3, [a, b], 'UTC', 'member-b'), '2026-11-01');
  const input = completionInput([completed('common')]);
  const undone = deriveOccurrenceCompletion({ ...input, undos: [{ ...stamp('undo', 'undo', { common: 1 }), targetOperationId: 'common', authorUserId: 'member-b' }] });
  assert.equal(minimumNextExecutionDay(3, undone.active, 'UTC', null), null);
});
test('v2 work fulfillment is separate from recorded time and exact end completion is valid without changing interval conflict semantics', () => {
  const target = { precision: 'interval', start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' };
  assert.equal(fulfillmentAt('2026-10-27T10:00:00Z', { mode: 'fixed', target }, 'UTC'), 'fulfilled');
  assert.equal(fulfillmentAt('2026-10-27T10:00:00.001Z', { mode: 'fixed', target }, 'UTC'), 'later');
  assert.equal(fulfillmentAt('2026-10-27T08:59:00Z', { mode: 'fixed', target }, 'UTC'), 'earlier');
  assert.equal(fulfillmentAt('2026-10-26T10:00:00Z', { mode: 'day', target: { precision: 'date', date: '2026-10-27' } }, 'UTC'), 'earlier');
  assert.equal(fulfillmentAt('2026-10-26T10:00:00Z', { mode: 'deadline', target: { precision: 'date', date: '2026-10-27' } }, 'UTC'), 'fulfilled');
  const work = completed('late-record', null, { performedAt: '2026-10-25T10:00:00Z', recordedAt: '2026-10-27T10:00:00Z' });
  assert.equal(deriveOccurrenceCompletion(completionInput([work])).history[0].performedAt, '2026-10-25T10:00:00Z');
});
test('v2 expired home visibility is exactly five civil days independently of recurrence consumption', () => {
  for (const [today, expected] of [['2026-10-26', false], ['2026-10-27', false], ['2026-10-28', true], ['2026-11-01', true], ['2026-11-02', false]]) {
    assert.equal(showExpiredOnHome('2026-10-27', today), expected);
  }
});
