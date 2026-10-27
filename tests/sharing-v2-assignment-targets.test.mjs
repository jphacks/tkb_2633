import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionFixture, ref } from './helpers/sharing-v2-decision-fixture.mjs';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

test('v2 next assignment follows the next real cadence segment instead of adding the old interval', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.patchChoreConfiguration('floor', 1, { intervalDays: 3, anchorDate: '2026-10-29' }, '2026-10-29');
    const [assignment] = await f.a.actions.assign(ref, ['member'], 'next', true);
    assert.equal(assignment.payload.fromAnchorDate, '2026-10-29'); assert.equal(assignment.payload.ruleVersion, 2);
    assert.equal(assignment.payload.fromOccurrenceId, v2OccurrenceId(groupId, 'floor', '2026-10-29'));
    await f.deliver(f.owner); assert.deepEqual(f.member.state(), f.owner.state());
  } finally { f.close(); }
});

test('v2 next assignment skips a disabled period and binds the future active rule revision', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.patchChoreConfiguration('floor', 1, { active: false }, '2026-10-29');
    await f.a.actions.patchChoreConfiguration('floor', 2, { active: true, anchorDate: '2026-11-10', intervalDays: 14 }, '2026-11-10');
    const [assignment] = await f.a.actions.assign(ref, ['member'], 'next', false);
    assert.equal(assignment.payload.fromAnchorDate, '2026-11-10'); assert.equal(assignment.payload.ruleVersion, 3);
    await f.deliver(f.owner); assert.deepEqual(f.member.state(), f.owner.state());
  } finally { f.close(); }
});

test('v2 a members next assignment request uses the same actual future occurrence and leaves this rounds assignees intact', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.patchChoreConfiguration('floor', 1, { intervalDays: 3, anchorDate: '2026-10-29' }, '2026-10-29'); await f.deliver(f.owner);
    const [request] = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'next', scope: 'once', fixed: false });
    assert.equal(request.payload.anchorDate, '2026-10-29'); assert.equal(request.payload.ruleVersion, 2);
    assert.deepEqual(request.payload.originalMemberIds, ['member']);
    const before = (await listSharingOutbox(f.member.database, groupId)).length;
    const again = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'next', scope: 'once', fixed: false });
    assert.deepEqual(again, []); assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
    const plan = await f.b.actions.readPlan({ from: ref.anchorDate, through: '2026-11-04', asOfDate: ref.anchorDate });
    assert.deepEqual(plan.occurrences.find((round) => round.choreId === 'floor' && round.anchorDate === ref.anchorDate).assigneeIds, ['member']);
  } finally { f.close(); }
});

test('v2 a displayed next occurrence is read without mutation and cannot be reused after a future cadence change', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    const target = await f.a.actions.readAssignmentTarget(ref, 'next'); assert.equal(target.anchorDate, '2026-11-03');
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    await f.a.actions.patchChoreConfiguration('floor', 1, { intervalDays: 3, anchorDate: '2026-10-29' }, '2026-10-29');
    const after = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.assign(ref, ['member'], 'next', true, { expectedTargetOccurrenceId: target.occurrenceId }), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, after);
  } finally { f.close(); }
});

test('v2 a next assignment does not invent a future occurrence after an indefinite disable', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.a.actions.patchChoreConfiguration('floor', 1, { active: false }, '2026-10-29');
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.assign(ref, ['member'], 'next', false), /次回の有効な家事回がありません/);
    await assert.rejects(f.a.actions.readAssignmentTarget(ref, 'next'), /次回の有効な家事回がありません/);
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
  } finally { f.close(); }
});

test('v2 next assignment stops for a disputed future configuration instead of choosing an arbitrary cadence', async () => {
  const f = await decisionFixture({ fixed: true, secondOwner: true });
  try {
    await f.a.actions.patchChoreConfiguration('floor', 1, { intervalDays: 3, anchorDate: '2026-10-29' }, '2026-10-29');
    await f.c.actions.patchChoreConfiguration('floor', 1, { intervalDays: 4, anchorDate: '2026-10-29' }, '2026-10-29');
    await f.deliver(f.owner2, [f.owner]);
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.assign(ref, ['member'], 'next', false), /次回の周期設定が競合/);
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
  } finally { f.close(); }
});

test('v2 a one-off next assignment affects that actual occurrence without rewriting this or later rounds', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    const target = await f.a.actions.readAssignmentTarget(ref, 'next');
    await f.a.actions.assign(ref, ['owner'], 'next', true, { scope: 'once', expectedTargetOccurrenceId: target.occurrenceId,
      expectedAssignmentIds: target.assignmentIds, expectedConflictIds: target.conflictIds });
    const plan = await f.a.actions.readPlan({ from: ref.anchorDate, through: '2026-11-10', asOfDate: ref.anchorDate });
    const members = (date) => plan.occurrences.find((round) => round.choreId === 'floor' && round.anchorDate === date).assigneeIds;
    assert.deepEqual(members(ref.anchorDate), ['member']); assert.deepEqual(members('2026-11-03'), ['owner']); assert.deepEqual(members('2026-11-10'), ['member']);
  } finally { f.close(); }
});
