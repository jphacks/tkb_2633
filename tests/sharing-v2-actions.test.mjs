import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, draft, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2GroupBootstrap } from '../src/features/sharing/v2/bootstrap.ts';
import { applyReceivedSharedFacts, loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
function actions(d) { let id = 0; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-action-${++id}`, now }); }

test('v2 actions record completion and targeted undo atomically and make repeated checkbox taps idempotent', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [one, duplicate] = await Promise.all([a.complete(ref), a.complete(ref)]); assert.equal(one.length + duplicate.length, 1);
    let plan = await a.readPlan(range); assert.equal(plan.occurrences[0].completed, true); assert.equal(plan.history[0].instruction.kind, 'automatic');
    assert.equal(plan.history[0].recordedAt, now().toISOString());
    const [undo, twice] = await Promise.all([a.undo(one[0].operationId), a.undo(one[0].operationId)]); assert.equal(undo.length + twice.length, 1);
    plan = await a.readPlan(range); assert.equal(plan.history.length, 1); assert.equal(plan.history[0].active, false); assert.equal(plan.occurrences[0].completed, false);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});
test('v2 actions keep bootstrap separate, require explicit activation and protect administrator settings from members', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const operations = v2GroupBootstrap({ groupId, ownerUserId: 'owner', ownerDisplayName: '所有者', name: '検査', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27', kind: 'roommates' });
    await owner.repository.commit(operations); const a = actions(owner); let plan = await a.readPlan(range);
    assert.equal(plan.chores.length, 20); assert.equal(plan.chores.some((chore) => chore.enabled), false); assert.equal(plan.occurrences.length, 0);
    assert.equal(plan.policy.kind, 'roommates'); const choreId = plan.chores[0].id;
    await a.configureChore(choreId, { policy: chorePolicyFromPreset('eachMember'), anchorDate: '2026-10-29', intervalDays: 3, windowBeforeDays: 0, windowAfterDays: 1, effectiveFrom: '2026-10-29', active: true });
    plan = await a.readPlan(range); assert.equal(plan.occurrences[0].anchorDate, '2026-10-29');
    const facts = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, facts, String(facts.length), member.repository.project, null, now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(facts)));
    await assert.rejects(actions(member).configureChore(choreId, { ...plan.occurrences[0].configuration, effectiveFrom: '2026-10-30', active: false }), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(member.database, groupId)).length, 0);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 actions choose a direct date or signed request from current permission and preserve original work after cancelling dates', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [direct] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, options: { strict: true } });
    assert.equal(direct.entityType, 'designation'); await a.complete(ref, { performedAt: '2026-10-26T23:00:00Z' });
    const before = (await a.readPlan(range)).history; await a.cancelDates(ref, [direct.operationId]);
    assert.deepEqual((await a.readPlan(range)).history, before); assert.equal((await a.readPlan(range)).history[0].strictInstructionFulfilled, false);
  } finally { d.connection.close(); }
});
test('v2 actions retain original group options when changing family and roommate presets', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.patchGroupPolicy({ allowSubstitution: false, completionPushEnabled: true });
    await a.changeGroupKind('roommates'); const plan = await a.readPlan(range);
    assert.equal(plan.policy.kind, 'roommates'); assert.equal(plan.policy.allowSubstitution, false); assert.equal(plan.policy.completionPushEnabled, true);
  } finally { d.connection.close(); }
});
test('v2 actions claim, release and explicit assignment affect only their intended common rounds', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d); await a.claim(ref); assert.equal((await a.claim(ref)).length, 0);
    assert.deepEqual((await a.readPlan(range)).occurrences[0].assigneeIds, ['owner']);
    await a.releaseClaim(ref); assert.deepEqual((await a.readPlan(range)).occurrences[0].assigneeIds, []);
    await a.assign(ref, ['member'], 'next', true); const plan = await a.readPlan(range);
    assert.deepEqual(plan.occurrences[0].assigneeIds, []); assert.deepEqual(plan.occurrences[1].assigneeIds, ['member']);
  } finally { d.connection.close(); }
});

test('v2 actions require recent-work confirmation before an administrator repeats a short-cycle task without changing its completed past round', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.intervalDays = 3; await d.repository.commit(initial); const a = actions(d);
    await a.complete(ref); const before = (await a.readPlan(range)).history;
    const next = { ...ref, anchorDate: '2026-10-30' }; const target = { precision: 'date', date: '2026-10-27' };
    await assert.rejects(a.changeDate(next, { mode: 'day', target }), (error) => error.reason === 'recentWork');
    await a.changeDate(next, { mode: 'day', target, confirmRecentWork: true });
    const plan = await a.readPlan(range); assert.deepEqual(plan.history, before); assert.equal(plan.occurrences[0].completed, true);
    assert.equal(plan.occurrences[1].subjects[0].formalDate.allowDuringCooldown, true); assert.equal(plan.occurrences[1].subjects[0].cooldownSuppressed, false);
  } finally { d.connection.close(); }
});
test('v2 actions require an explicit high-load confirmation and roll back a cancelled designation', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds());
    await d.repository.commit([draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }), draft('heavy', 'chore', 'floor', { load: 'heavy' }),
      draft('mop', 'chore', 'mop', { name: '床の水拭き', enabled: true, load: 'heavy' }),
      draft('mop-configuration', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
    const a = actions(d); const before = (await listSharingOutbox(d.database, groupId)).length;
    await assert.rejects(a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: ref.anchorDate } }), (error) => error.reason === 'highLoad');
    assert.equal((await listSharingOutbox(d.database, groupId)).length, before);
    await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: ref.anchorDate }, confirmHighLoad: true });
    assert.equal((await a.readPlan(range)).occurrences.find((entry) => entry.choreId === 'floor').subjects[0].formalDate.kind, 'manual');
  } finally { d.connection.close(); }
});
