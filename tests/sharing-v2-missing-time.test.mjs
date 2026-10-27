import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, groupId, draft, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { loadSharedFacts, applyReceivedSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

const now = () => new Date('2026-03-05T12:00:00Z');
const ref = { choreId: 'floor', anchorDate: '2026-03-08', ruleVersion: 1, subjectUserId: null };
const range = { from: '2026-03-01', through: '2026-03-15', asOfDate: '2026-03-05' };
const target = { precision: 'interval', start: '2026-03-08T07:30:00.000Z', end: '2026-03-08T07:45:00.000Z' };
async function setup({ consent = false } = {}) {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  const actions = (d) => { let id = 0; d.options.now = now; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-gap-${++id}`, now }); };
  const a = actions(owner); const b = actions(member);
  const initial = seeds(); initial[1].payload.timeZone = 'America/New_York'; initial[1].payload.anchorDate = '2026-03-01';
  initial[3].payload.configuration.anchorDate = '2026-03-01'; initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']);
  await owner.repository.commit(initial);
  const [source] = await a.changeDate({ ...ref, anchorDate: '2026-03-01' }, { mode: 'fixed',
    target: { precision: 'interval', start: '2026-03-01T07:30:00.000Z', end: '2026-03-01T07:45:00.000Z' }, selector: { scope: 'ongoing', from: '2026-03-01' }, options: { strict: true } });
  if (consent) await a.patchGroupPolicy({ adminCanFixWithoutConsent: false });
  const deliver = async (facts, receivedAt = now().getTime()) => { for (const d of [owner, member]) {
    const previous = await readSharingCheckpoint(d.database, groupId);
    const evidence = receiptsFor(facts).map((r) => ({ ...r, receivedAtMs: receivedAt }));
    await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, previous.cursor, receivedAt, d.repository.evidenceForServerReceipts(evidence));
  } };
  await deliver(await loadSharedFacts(owner.database, groupId));
  return { owner, member, a, b, source, deliver, close() { owner.connection.close(); member.connection.close(); } };
}

test('v2 missing-clock date requests use only the proposed deadline while preserving null formal time, consent, source history and surrounding repeats', async () => {
  const f = await setup();
  try {
    const round = (await f.b.readPlan(range)).occurrences.find((r) => r.anchorDate === ref.anchorDate); assert.equal(round.subjects[0].formalDate.kind, 'review');
    const [request] = await f.b.changeDate(ref, { mode: 'fixed', target, expectedRuleIds: [f.source.operationId], confirmDateConflict: true });
    assert.equal(request.entityType, 'changeRequest'); assert.equal(request.payload.original, null);
    let state = (await f.member.repository.readState()).assessment.requestStates[0];
    assert.equal(state.kind, 'pendingDelivery'); assert.equal(state.formal, null); assert.equal(state.original, null);
    await f.deliver(await loadSharedFacts(f.member.database, groupId));
    state = (await f.member.repository.readState()).assessment.requestStates[0]; assert.equal(state.kind, 'awaiting'); assert.equal(state.formal, null);
    assert.equal(state.deadline.referenceAt, Date.parse(target.start)); assert.equal(state.deadline.expiresAt, now().getTime() + 24 * 3600000);
    const [vote] = await f.a.decide(request.operationId, 'approve'); assert.equal((await f.a.readPlan(range)).occurrences.find((r) => r.anchorDate === ref.anchorDate).subjects[0].formalDate.kind, 'review');
    await f.deliver(await loadSharedFacts(f.owner.database, groupId));
    for (const d of [f.owner, f.member]) {
      const s = await d.repository.readState(); assert.equal(s.assessment.requestStates[0].kind, 'approved'); assert.deepEqual(s.assessment.requestStates[0].formal, target);
      const proofIds = (proof) => proof.kind === 'operation' ? [proof.operationId] : proof.entries.flatMap(proofIds);
      assert.ok(proofIds(s.assessment.requestStates[0].confirmation).includes(vote.operationId));
      const plan = await createV2PlannerActions(d.repository, { makeId: () => 'unused', now }).readPlan(range);
      assert.deepEqual(plan.occurrences.find((r) => r.anchorDate === ref.anchorDate).subjects[0].formalDate.target, target);
      assert.equal(plan.occurrences.find((r) => r.anchorDate === '2026-03-15').subjects[0].formalDate.target.start, '2026-03-15T06:30:00.000Z');
      assert.equal(s.assessment.view.byId(f.source.operationId).payload.configuration.target.start, '2026-03-01T07:30:00.000Z'); assert.deepEqual(s.assessment.rejected, []);
    }
    assert.equal(f.owner.state().hash, f.member.state().hash);
  } finally { f.close(); }
});

test('v2 missing-clock repair requires explicit observed rules and cannot bypass roommate assignee consent even for an administrator', async () => {
  const f = await setup({ consent: true });
  try {
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.changeDate(ref, { mode: 'fixed', target }));
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    const [request] = await f.a.changeDate(ref, { mode: 'fixed', target, expectedRuleIds: [f.source.operationId], confirmDateConflict: true });
    assert.equal(request.entityType, 'changeRequest'); await f.deliver(await loadSharedFacts(f.owner.database, groupId));
    assert.equal((await f.owner.repository.readState()).assessment.requestStates[0].kind, 'awaiting');
    await f.b.decide(request.operationId, 'approve'); await f.deliver(await loadSharedFacts(f.member.database, groupId));
    assert.equal((await f.owner.repository.readState()).assessment.requestStates[0].kind, 'approved');
  } finally { f.close(); }
});

test('v2 receivers reject fabricated missing originals on ordinary clocks and fabricated instants for a genuinely missing clock without enqueueing them', async () => {
  const f = await setup();
  try {
    const valid = { ...ref, anchorDate: '2026-03-15' };
    const [request] = await f.b.changeDate(valid, { mode: 'fixed', target: { ...target, start: '2026-03-15T07:30:00.000Z', end: '2026-03-15T07:45:00.000Z' } });
    const original = request.payload.original; assert.notEqual(original, null);
    const before = (await listSharingOutbox(f.member.database, groupId)).length;
    await assert.rejects(f.member.repository.commit([draft('fake-gap', 'changeRequest', 'fake-gap', { ...request.payload, original: null })]));
    assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
    const [gap] = await f.b.changeDate(ref, { mode: 'fixed', target, expectedRuleIds: [f.source.operationId], confirmDateConflict: true });
    const after = (await listSharingOutbox(f.member.database, groupId)).length;
    await assert.rejects(f.member.repository.commit([draft('fake-formal-time', 'changeRequest', 'fake-formal-time', { ...gap.payload, original })]));
    assert.equal((await listSharingOutbox(f.member.database, groupId)).length, after);
  } finally { f.close(); }
});

test('v2 concurrent missing-clock rules with different source clock meanings remain conflicts instead of collapsing to the same review reason', () => {
  const rule = { id: 'first', choreId: 'floor', subjectUserId: null, selector: { scope: 'ongoing', from: '2026-03-01' }, referenceAnchorDate: '2026-03-01',
    timeZoneAtCreation: 'America/New_York', mode: 'deadline', target: { precision: 'instant', at: '2026-03-01T07:15:00.000Z' },
    strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'owner', ruleVersion: 1 };
  const fact = (id, source) => ({ operationId: id, authorDeviceId: id, deviceSequence: 1, context: {}, rule: { ...source, id } });
  const occurrence = { id: 'round', choreId: 'floor', anchorDate: '2026-03-08', ruleVersion: 1 };
  const first = fact('first', rule); const second = fact('second', { ...rule, target: { precision: 'instant', at: '2026-03-01T07:45:00.000Z' } });
  assert.equal(selectManualRule([first, second], occurrence, null, 'America/New_York').kind, 'conflict');
  assert.equal(selectManualRule([first, fact('same', rule)], occurrence, null, 'America/New_York').kind, 'selected');
});

test('v2 missing-clock requests remain unresolved after an offline late approval and counteroffers cannot extend the proposed-only deadline', async () => {
  const { fixture: requestFixture, instant, start, hour } = await import('./helpers/sharing-v2-request-fixture.mjs');
  for (const late of [false, true]) {
    const f = await requestFixture({ mode: 'deadline', original: null, proposed: instant(120) });
    const context = { permission: { kind: 'approvalRequired', approver: 'admin', reason: 'fixed' }, assigneeIds: ['a'], timeZone: 'America/New_York', originalMissingTime: true, originalWasConflicted: true };
    assert.throws(() => f.state(), /verified/);
    f.decide('owner', 'approve', { at: start + 24 * hour + (late ? 1 : 0) });
    const state = f.state({ context }); assert.equal(state.kind, late ? 'expired' : 'approved');
    assert.equal(state.deadline.referenceAt, start + 120 * hour); assert.equal(state.original, null);
    if (late) { assert.equal(state.formal, null); assert.equal(state.confirmation, null); assert.equal(state.decisions[0].kind, 'late'); }
  }
  const f = await requestFixture({ mode: 'deadline', original: null, proposed: instant(120) });
  const context = { permission: { kind: 'approvalRequired', approver: 'admin', reason: 'fixed' }, assigneeIds: ['a'], timeZone: 'America/New_York', originalMissingTime: true };
  f.decide('owner', 'counteroffer', { target: instant(150) });
  assert.equal(f.state({ context }).counteroffers[0].expiresAt, start + 24 * hour);
  assert.equal(f.state({ context }).formal, null);
});

test('v2 uncertain future clocks always require a signed request including administrator repairs and distinguish gaps from real repeated instants', async () => {
  const f = await setup();
  try {
    const [request] = await f.a.changeDate(ref, { mode: 'fixed', target, expectedRuleIds: [f.source.operationId], confirmDateConflict: true });
    assert.equal(request.entityType, 'changeRequest'); assert.equal(request.payload.original, null);
    const rule = { ...f.source.payload.configuration, id: 'forged-direct-repair', referenceAnchorDate: ref.anchorDate, selector: request.payload.selector,
      target, basisRuleIds: [f.source.operationId] };
    await assert.rejects(f.owner.repository.commit([draft(rule.id, 'designation', rule.id, { configuration: rule })]), { code: 'sharing/v2-authority-denied' });
  } finally { f.close(); }
  const { v2DateChangeOriginal } = await import('../src/features/sharing/v2/date-change-original.ts');
  const rule = { choreId: 'floor', subjectUserId: null, selector: { scope: 'ongoing', from: '2026-10-25' }, referenceAnchorDate: '2026-10-25', timeZoneAtCreation: 'America/New_York',
    mode: 'deadline', target: { precision: 'instant', at: '2026-10-25T05:30:00.000Z' }, ruleVersion: 1 };
  const round = { choreId: 'floor', anchorDate: '2026-11-01', ruleVersion: 1 };
  const state = v2DateChangeOriginal([rule], round, 'America/New_York');
  assert.equal(state.unresolved, true); assert.equal(state.originalMissingTime, false); assert.deepEqual(state.original, { precision: 'instant', at: '2026-11-01T05:30:00.000Z' });
  assert.equal(state.targets.length, 2);
  assert.throws(() => v2DateChangeOriginal([rule], { ...round, ruleVersion: 2 }, 'America/New_York'), /周期や地域/);
  assert.throws(() => v2DateChangeOriginal([rule], round, 'Asia/Tokyo'), /周期や地域/);
});
