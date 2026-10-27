import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { decisionFixture } from './helpers/sharing-v2-decision-fixture.mjs';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { loadSharedFacts, applyReceivedSharedFacts, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const range = { from: ref.anchorDate, through: '2026-11-04', asOfDate: ref.anchorDate };
function actions(d) { let i = 0; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-cancel-request-${++i}`, now }); }
async function setup({ perMember = false, observer = false } = {}) {
  const f = await fixture(); let observerIdentity;
  if (observer) { observerIdentity = await createDeviceIdentity(sharingTestCrypto); f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'observer', observerIdentity)); }
  const owner = await f.device(); const member = await f.device('member', f.member); const other = observerIdentity ? await f.device('observer', observerIdentity) : null;
  const initial = seeds(); initial[3].payload.configuration.policy = perMember ? chorePolicyFromPreset('eachMember') : chorePolicyFromPreset('assigned', ['member']);
  const reference = { ...ref, subjectUserId: perMember ? 'member' : null };
  await owner.repository.commit(initial); const a = actions(owner); const b = actions(member);
  const [rule] = await a.changeDate(reference, { mode: 'fixed', target: { precision: 'interval', start: '2026-10-29T02:00:00Z', end: '2026-10-29T03:00:00Z' },
    options: { strict: true, adminLocked: true }, selector: { scope: 'ongoing', from: ref.anchorDate } });
  const devices = [owner, member, ...(other ? [other] : [])]; const cursors = new Map();
  const receiptTimes = new Map();
  async function sync(overrides = new Map()) {
    const all = new Map(); for (const device of devices) for (const fact of await loadSharedFacts(device.database, groupId)) all.set(fact.operation.operationId, fact);
    const facts = [...all.values()].sort((x,y) => x.operation.logicalClock-y.operation.logicalClock || x.operation.operationId.localeCompare(y.operation.operationId));
    for (const [id,time] of overrides) { assert.ok(!receiptTimes.has(id)); receiptTimes.set(id,time); }
    const receipts = receiptsFor(facts).map((receipt) => { if (!receiptTimes.has(receipt.operationId)) receiptTimes.set(receipt.operationId,receipt.receivedAtMs);
      return { ...receipt, receivedAtMs: receiptTimes.get(receipt.operationId) }; });
    for (const device of devices) {
      await applyReceivedSharedFacts(device.database, groupId, facts, String(facts.length), device.repository.project, cursors.get(device) ?? null, now().getTime(), device.repository.evidenceForServerReceipts(receipts));
      cursors.set(device, String(facts.length));
    }
  }
  await sync(); const round = (await a.readPlan(range)).occurrences[0];
  return { owner, member, a, b, c: other ? actions(other) : null, rule, sync, ref: reference, selector: { scope: 'once', occurrenceId: round.id, anchorDate: ref.anchorDate }, close() { for (const device of devices) device.connection.close(); } };
}
test('v2 a member requests removal of a locked date without changing the formal schedule before receipt-backed approval', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector, expectedRuleIds: [f.rule.operationId] });
    assert.equal(request.entityType, 'changeRequest'); assert.deepEqual(request.payload.cancellation, { targetOperationIds: [f.rule.operationId], selector: f.selector });
    assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'pendingDelivery');
    assert.equal((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.mode, 'fixed');
    await f.sync(); assert.equal((await f.owner.repository.readState()).assessment.requestStates[0].kind, 'awaiting');
    await f.a.decide(request.operationId, 'approve');
    assert.equal((await f.a.readPlan(range)).occurrences[0].subjects[0].formalDate.mode, 'fixed');
    await f.sync(); const state = (await f.member.repository.readState()).assessment.requestStates[0]; assert.equal(state.kind, 'approved'); assert.equal(state.formalAction, 'cancel');
    const plan = await f.b.readPlan(range); assert.equal(plan.occurrences[0].subjects[0].formalDate.kind, 'automatic');
    assert.equal(plan.occurrences[1].subjects[0].formalDate.mode, 'fixed'); assert.deepEqual(plan, await f.a.readPlan(range));
  } finally { f.close(); }
});
test('v2 a cancellation counteroffer at the same baseline is still an explicit date and needs its own acceptance', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    const [offer] = await f.a.decide(request.operationId, 'counteroffer', { precision: 'date', date: ref.anchorDate }); await f.sync();
    assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'counteroffered');
    assert.equal((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.mode, 'fixed');
    await f.b.decide(request.operationId, 'acceptCounteroffer', null, offer.operationId); await f.sync();
    const state = (await f.member.repository.readState()).assessment.requestStates[0]; assert.equal(state.formalAction, 'designate');
    const plan = await f.b.readPlan(range); assert.equal(plan.occurrences[0].subjects[0].formalDate.kind, 'manual'); assert.equal(plan.occurrences[0].subjects[0].formalDate.mode, 'day');
    assert.equal(plan.occurrences[1].subjects[0].formalDate.mode, 'fixed'); assert.deepEqual(plan, await f.a.readPlan(range));
  } finally { f.close(); }
});
test('v2 concurrent cancellation approval and accepted same-date designation retain an explicit action conflict on every device', async () => {
  const f = await decisionFixture({ cancellation: true, secondOwner: true });
  try {
    await f.a.actions.decide(f.request.operationId, 'approve');
    const [offer] = await f.c.actions.decide(f.request.operationId, 'counteroffer', { precision: 'date', date: ref.anchorDate });
    await f.deliver(f.owner, [f.owner, f.member, f.owner2]); await f.deliver(f.owner2, [f.owner, f.member, f.owner2]);
    await f.b.actions.decide(f.request.operationId, 'acceptCounteroffer', null, offer.operationId);
    await f.deliver(f.member, [f.owner, f.member, f.owner2]);
    for (const controller of [f.a, f.b, f.c]) {
      const model = await controller.readModel(range); assert.equal(model.requests[0].kind, 'conflict'); assert.equal(model.requests[0].formalAction, null);
      assert.ok(model.requests[0].conflictIds.length >= 2); assert.equal(model.plan.occurrences[0].subjects[0].formalDate.target.date, '2026-10-30');
      assert.ok(model.plan.occurrences[0].subjects[0].requestReviewIds.includes(f.request.operationId));
    }
  } finally { f.close(); }
});
test('v2 a cancellation answer cannot clear a different date source that changed after the request was displayed', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    await f.a.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' }, options: { strict: false, adminLocked: false }, expectedRuleIds: [f.rule.operationId] });
    await assert.rejects(f.a.decide(request.operationId, 'approve'));
    assert.equal((await f.a.readPlan(range)).occurrences[0].subjects[0].formalDate.target.date, '2026-10-28');
  } finally { f.close(); }
});
test('v2 a cancellation cannot forge its fallback, target source, scope or window extension and never adds those attempts to the outbox', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); const before = await listSharingOutbox(f.member.database, groupId);
    const copies = [
      { proposed: { precision: 'date', date: '2026-11-10' } },
      { cancellation: { ...request.payload.cancellation, targetOperationIds: ['unknown-date-rule'] } },
      { cancellation: { ...request.payload.cancellation, selector: { scope: 'ongoing', from: ref.anchorDate } } },
      { extensionScope: 'future' },
    ];
    let i = 0; for (const patch of copies) { const id = `forged-removal-${++i}`;
      await assert.rejects(f.member.repository.commit([draft(id, 'changeRequest', id, { ...request.payload, ...patch })]));
      assert.deepEqual(await listSharingOutbox(f.member.database, groupId), before);
    }
  } finally { f.close(); }
});
test('v2 work recorded while a removal awaits approval retains its actual original instruction after cancellation', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    await f.b.complete(ref); assert.equal((await f.b.readPlan(range)).history[0].instruction.kind, 'designated');
    await f.sync(); const history = (await f.b.readPlan(range)).history; assert.equal(history[0].performedTimeConfirmed, true);
    await f.a.decide(request.operationId, 'approve'); await f.sync();
    const plan = await f.b.readPlan(range); assert.deepEqual(plan.history, history); assert.equal(plan.occurrences[0].completed, true);
    assert.equal(plan.history[0].instruction.ruleId, f.rule.operationId);
  } finally { f.close(); }
});
test('v2 an offline cancellation approval received after its server deadline stays expired and keeps its original date and answer history', async () => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    const state = (await f.owner.repository.readState()).assessment.requestStates[0]; assert.equal(state.deadline.kind, 'open');
    const [answer] = await f.a.decide(request.operationId, 'approve'); await f.sync(new Map([[answer.operationId, state.deadline.expiresAt + 1]]));
    const expired = (await f.member.repository.readState()).assessment.requestStates[0]; assert.equal(expired.kind, 'expired'); assert.equal(expired.formalAction, null);
    assert.ok(expired.decisions.some((decision) => decision.operationId === answer.operationId && decision.kind === 'late'));
    assert.equal((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.mode, 'fixed');
    assert.deepEqual((await f.member.repository.readState()).assessment.view.dateCancellationsAt(), []);
  } finally { f.close(); }
});
test('v2 roommate administrators request an assignees consent for removal and cannot approve their own request', async () => {
  const f = await setup();
  try {
    await f.a.patchGroupPolicy({ kind: 'roommates', adminCanFixWithoutConsent: false }); await f.sync();
    const [request] = await f.a.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); assert.equal(request.entityType, 'changeRequest'); await f.sync();
    await assert.rejects(f.a.decide(request.operationId, 'approve'), { code: 'sharing/v2-authority-denied' });
    await f.b.decide(request.operationId, 'approve'); await f.sync();
    assert.equal((await f.a.readPlan(range)).occurrences[0].subjects[0].formalDate.kind, 'automatic');
  } finally { f.close(); }
});
test('v2 a third members locked-date removal in a consent-based group requires both the administrator and actual assignee', async () => {
  const f = await setup({ observer: true });
  try {
    await f.a.patchGroupPolicy({ kind: 'roommates', adminCanFixWithoutConsent: false }); await f.sync();
    const [request] = await f.c.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    let state = (await f.owner.repository.readState()).assessment.requestStates[0]; assert.equal(state.audience.administratorVote, true);
    assert.deepEqual(state.audience.approvingMemberIds, ['member']);
    await f.a.decide(request.operationId, 'approve'); await f.sync();
    assert.equal((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.mode, 'fixed');
    await f.b.decide(request.operationId, 'approve'); await f.sync(); state = (await f.owner.repository.readState()).assessment.requestStates[0];
    assert.equal(state.kind, 'approved'); assert.equal(state.formalAction, 'cancel');
  } finally { f.close(); }
});
test('v2 a per-member cancellation approval affects only the requested subject while keeping the other members instruction', async () => {
  const f = await setup({ perMember: true });
  try {
    await f.a.changeDate({ ...ref, subjectUserId: 'owner' }, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } }); await f.sync();
    const [request] = await f.b.cancelDates(f.ref, [f.rule.operationId], { selector: f.selector }); await f.sync(); await f.a.decide(request.operationId, 'approve'); await f.sync();
    const round = (await f.b.readPlan(range)).occurrences[0];
    assert.equal(round.subjects.find((subject) => subject.subjectUserId === 'member').formalDate.kind, 'automatic');
    assert.equal(round.subjects.find((subject) => subject.subjectUserId === 'owner').formalDate.target.date, '2026-10-28');
  } finally { f.close(); }
});
test('v2 a whole-rule cancellation counteroffer retains the original repeating scope when requested from a later round', async () => {
  const f = await setup();
  try {
    const later = { ...ref, anchorDate: '2026-11-03' };
    const [request] = await f.b.cancelDates(later, [f.rule.operationId]); assert.equal(request.payload.cancellation.selector, null);
    assert.deepEqual(request.payload.selector, { scope: 'ongoing', from: ref.anchorDate }); await f.sync();
    const [offer] = await f.a.decide(request.operationId, 'counteroffer', { precision: 'date', date: later.anchorDate }); await f.sync();
    await f.b.decide(request.operationId, 'acceptCounteroffer', null, offer.operationId); await f.sync();
    const plan = await f.b.readPlan(range); assert.equal(plan.occurrences[0].subjects[0].formalDate.mode, 'day');
    assert.equal(plan.occurrences[0].subjects[0].suggestedDate, ref.anchorDate);
    assert.equal(plan.occurrences[1].subjects[0].suggestedDate, later.anchorDate);
  } finally { f.close(); }
});
test('v2 removing a manual date lets the automatic planner respect required order without allowing an earlier manual counteroffer', async () => {
  const f = await setup();
  try {
    await f.owner.repository.commit([
      draft('prepare', 'chore', 'prepare', { name: '先に必要な準備', enabled: true }),
      draft('prepare-config', 'chorePolicy', 'prepare', { configuration: seeds()[3].payload.configuration }),
      draft('prepare-order', 'dependency', 'prepare-order', { predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true } }),
    ]);
    await f.a.changeDate({ ...ref, choreId: 'prepare' }, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } }); await f.sync();
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync();
    await assert.rejects(f.a.decide(request.operationId, 'counteroffer', { precision: 'date', date: ref.anchorDate }), { code: 'sharing/v2-authority-denied' });
    await f.a.decide(request.operationId, 'approve'); await f.sync();
    const subject = (await f.b.readPlan(range)).occurrences.find((round) => round.choreId === 'floor').subjects[0];
    assert.equal(subject.formalDate.kind, 'automatic'); assert.equal(subject.dependencyNotBefore, '2026-10-28'); assert.equal(subject.suggestedDate, '2026-10-28');
  } finally { f.close(); }
});
test('v2 common planning reuses its read boundary instead of rescanning every event for each cancellation window', async (t) => {
  const f = await setup();
  try {
    const [request] = await f.b.cancelDates(ref, [f.rule.operationId], { selector: f.selector }); await f.sync(); await f.a.decide(request.operationId, 'approve'); await f.sync();
    const state = await f.owner.repository.readState(); const ready = state.assessment.view.ready; const originalIterator = ready[Symbol.iterator]; let scans = 0;
    ready[Symbol.iterator] = function* () { scans++; yield* originalIterator.call(this); };
    const period = { ...range, through: '2027-04-27' }; const plan = buildV2CommonPlan(state, period);
    t.diagnostic(`fullHistoryScans=${scans}; plannedRounds=${plan.occurrences.length}`);
    assert.ok(plan.occurrences.length >= 20); assert.ok(scans <= 4, `whole-history scans grew with the ${plan.occurrences.length} rounds: ${scans}`);
    delete ready[Symbol.iterator]; assert.deepEqual(buildV2CommonPlan(state, period), plan);
  } finally { f.close(); }
});
