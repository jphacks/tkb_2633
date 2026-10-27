import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, draft, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { applyReceivedSharedFacts, loadSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
function actions(d) { let i = 0; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-cancel-${++i}`, now }); }
async function setup() {
  const f = await fixture(); const d = await f.device(); const initial = seeds(); initial[3].payload.configuration.intervalDays = 1;
  await d.repository.commit(initial); const a = actions(d);
  const [rule] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
  return { f, d, a, rule };
}
function selected(plan, day) { return plan.occurrences.find((round) => round.anchorDate === day)?.subjects[0]; }

test('v2 a one-round cancellation preserves the repeating date on both sides and the source completion instruction', async () => {
  const { d, a, rule } = await setup();
  try {
    await a.complete(ref, { performedAt: '2026-10-26T23:00:00Z' }); const before = (await a.readPlan(range)).history;
    const targetRef = { ...ref, anchorDate: '2026-10-29' }; const target = (await a.readPlan(range)).occurrences.find((round) => round.anchorDate === targetRef.anchorDate);
    const selector = { scope: 'once', occurrenceId: target.id, anchorDate: target.anchorDate };
    const [cancel] = await a.cancelDates(targetRef, [rule.operationId], { selector, expectedRuleIds: [rule.operationId] });
    assert.deepEqual(cancel.payload.selector, selector); const plan = await a.readPlan(range);
    assert.equal(selected(plan, '2026-10-28').suggestedDate, '2026-10-29');
    assert.equal(selected(plan, '2026-10-29').formalDate.kind, 'automatic');
    assert.equal(selected(plan, '2026-10-30').suggestedDate, '2026-10-31');
    assert.deepEqual(plan.history, before);
  } finally { d.connection.close(); }
});
test('v2 bounded and future date cancellations preserve the untouched original ranges without resurrecting them after a new exception', async () => {
  const { d, a, rule } = await setup();
  try {
    await a.cancelDates({ ...ref, anchorDate: '2026-10-29' }, [rule.operationId], { selector: { scope: 'period', range: { from: '2026-10-29', through: '2026-10-31' } } });
    let plan = await a.readPlan(range);
    for (const day of ['2026-10-29', '2026-10-30', '2026-10-31']) assert.equal(selected(plan, day).formalDate.kind, 'automatic');
    assert.equal(selected(plan, '2026-10-28').formalDate.kind, 'manual'); assert.equal(selected(plan, '2026-11-01').formalDate.kind, 'manual');
    const changeRef = { ...ref, anchorDate: '2026-10-30' };
    const [exception] = await a.changeDate(changeRef, { mode: 'day', target: { precision: 'date', date: '2026-10-31' }, expectedRuleIds: [] });
    await a.cancelDates(changeRef, [exception.operationId]);
    assert.equal(selected(await a.readPlan(range), '2026-10-30').formalDate.kind, 'automatic');
    await a.cancelDates({ ...ref, anchorDate: '2026-11-02' }, [rule.operationId], { selector: { scope: 'ongoing', from: '2026-11-02' } });
    plan = await a.readPlan(range); assert.equal(selected(plan, '2026-11-01').formalDate.kind, 'manual');
    assert.equal(selected(plan, '2026-11-02').formalDate.kind, 'automatic'); assert.equal(selected(plan, '2026-11-09').formalDate.kind, 'automatic');
  } finally { d.connection.close(); }
});
test('v2 scoped cancellation rejects a forged occurrence or another starting round and rolls back its outbox', async () => {
  const { d, a, rule } = await setup();
  try {
    const before = await listSharingOutbox(d.database, groupId);
    await assert.rejects(a.cancelDates(ref, [rule.operationId], { selector: { scope: 'once', occurrenceId: 'unrelated-round', anchorDate: ref.anchorDate } }));
    await assert.rejects(a.cancelDates(ref, [rule.operationId], { selector: { scope: 'period', range: { from: '2026-11-01', through: '2026-11-03' } } }));
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
  } finally { d.connection.close(); }
});
test('v2 signed scoped cancellations converge after reverse and duplicate delivery and cannot cancel a later unseen rule', async () => {
  const { f, d, a, rule } = await setup(); const member = await f.device('member', f.member);
  try {
    await a.cancelDates(ref, [rule.operationId], { selector: { scope: 'period', range: { from: ref.anchorDate, through: '2026-10-29' } } });
    const targetRef = { ...ref, anchorDate: '2026-10-28' };
    await a.changeDate(targetRef, { mode: 'day', target: { precision: 'date', date: '2026-10-30' }, expectedRuleIds: [] });
    const facts = await loadSharedFacts(d.database, groupId); const receipts = receiptsFor(facts);
    let cursor = null;
    for (const incoming of [[...facts].reverse(), facts]) {
      await applyReceivedSharedFacts(member.database, groupId, incoming, String(facts.length), member.repository.project, cursor, now().getTime(), member.repository.evidenceForServerReceipts(receipts)); cursor = String(facts.length);
    }
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receipts));
    assert.deepEqual(await actions(member).readPlan(range), await a.readPlan(range));
    assert.equal(selected(await a.readPlan(range), '2026-10-28').suggestedDate, '2026-10-30');
    const before = await listSharingOutbox(member.database, groupId);
    await assert.rejects(member.repository.commit([draft('unauthorized-cancel', 'designationCancel', 'unauthorized-cancel', { targetOperationIds: [rule.operationId], selector: { scope: 'ongoing', from: ref.anchorDate } })]), { code: 'sharing/v2-authority-denied' });
    assert.deepEqual(await listSharingOutbox(member.database, groupId), before);
  } finally { d.connection.close(); member.connection.close(); }
});
test('v2 cancelling an approved future window expansion removes only the chosen rounds and preserves its proof elsewhere', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.intervalDays = 1; await d.repository.commit(initial); const a = actions(d);
    await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-31' }, extensionScope: 'future', selector: { scope: 'ongoing', from: ref.anchorDate } });
    const facts = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
    const rule = (await d.repository.readState()).assessment.approvedRules[0]; assert.ok(rule.confirmation);
    const targetRef = { ...ref, anchorDate: '2026-10-29' };
    await a.cancelDates(targetRef, [rule.operationId], { selector: { scope: 'period', range: { from: targetRef.anchorDate, through: '2026-10-30' } } });
    const plan = await a.readPlan(range);
    assert.equal(plan.occurrences.find((round) => round.anchorDate === '2026-10-28').windowEnd, '2026-11-01');
    assert.equal(plan.occurrences.find((round) => round.anchorDate === '2026-10-29').windowEnd, '2026-10-31');
    assert.equal(selected(plan, '2026-10-29').formalDate.kind, 'automatic');
    assert.equal(plan.occurrences.find((round) => round.anchorDate === '2026-10-31').windowEnd, '2026-11-04');
    assert.equal((await d.repository.readState()).assessment.requestStates[0].kind, 'approved');
  } finally { d.connection.close(); }
});
test('v2 a scoped date removal is bound to its subject and cannot borrow another chores rule or inject projection fields', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const initial = seeds(); initial[3].payload.configuration.intervalDays = 1; initial[3].payload.configuration.policy = chorePolicyFromPreset('eachMember');
    await d.repository.commit(initial); const a = actions(d); const own = { ...ref, subjectUserId: 'owner' }; const other = { ...ref, subjectUserId: 'member' };
    const [one] = await a.changeDate(own, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
    const [two] = await a.changeDate(other, { mode: 'day', target: { precision: 'date', date: '2026-10-29' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
    const round = (await a.readPlan(range)).occurrences[0]; const selector = { scope: 'once', occurrenceId: round.id, anchorDate: round.anchorDate };
    const before = await listSharingOutbox(d.database, groupId);
    await assert.rejects(a.cancelDates(own, [two.operationId], { selector }));
    await assert.rejects(d.repository.commit([draft('hidden-cancel', 'designation', 'hidden-cancel', { configuration: { ...one.payload.configuration, id: 'hidden-cancel', excludedSelectors: [selector] } })]));
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    await a.cancelDates(own, [one.operationId], { selector }); const updated = (await a.readPlan(range)).occurrences[0];
    assert.equal(updated.subjects.find((subject) => subject.subjectUserId === 'owner').formalDate.kind, 'automatic');
    assert.equal(updated.subjects.find((subject) => subject.subjectUserId === 'member').formalDate.target.date, '2026-10-29');
  } finally { d.connection.close(); }
});
test('v2 scoped removal excludes moved inverse-query anchors while retaining any completion on its recorded day', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const a = actions(d);
    const [rule] = await a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2027-01-25' }, selector: { scope: 'ongoing', from: ref.anchorDate } });
    const round = (await a.readPlan(range)).occurrences.find((candidate) => candidate.anchorDate === '2026-11-03');
    await a.cancelDates({ ...ref, anchorDate: round.anchorDate }, [rule.operationId], { selector: { scope: 'once', occurrenceId: round.id, anchorDate: round.anchorDate } });
    const moved = await a.readPlan({ from: '2027-02-01', through: '2027-02-01', asOfDate: ref.anchorDate });
    assert.equal(moved.occurrences.some((candidate) => candidate.anchorDate === round.anchorDate), false);
    const [work] = await a.complete(ref); const completed = (await a.readPlan(range)).occurrences.find((candidate) => candidate.anchorDate === ref.anchorDate);
    await a.cancelDates(ref, [rule.operationId], { selector: { scope: 'once', occurrenceId: completed.id, anchorDate: ref.anchorDate } });
    const retained = await a.readPlan({ from: '2027-01-25', through: '2027-01-25', asOfDate: ref.anchorDate });
    const original = retained.occurrences.find((candidate) => candidate.anchorDate === ref.anchorDate);
    assert.deepEqual(original.subjects[0].completionOperationIds, [work.operationId]); assert.equal(original.subjects[0].suggestedDate, '2027-01-25');
    assert.equal(retained.history[0].instruction.kind, 'designated');
  } finally { d.connection.close(); }
});
