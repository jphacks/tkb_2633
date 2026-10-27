import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { decisionFixture, range, ref } from './helpers/sharing-v2-decision-fixture.mjs';
import { draft, seeds, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { fixture as requestFixture } from './helpers/sharing-v2-request-fixture.mjs';
import { approvedRequestRuleId, approvedRequestRule } from '../src/features/sharing/v2/formal-rules.ts';

const day = (date) => ({ precision: 'date', date });
async function highLoad(f, date) {
  await f.owner.repository.commit([draft('limit', 'settings', 'settings', { heavyDailyLimit: 1 }),
    draft('floor-load', 'chore', 'floor', { load: 'heavy' }),
    draft('mop', 'chore', 'mop', { name: '水拭き', load: 'heavy', enabled: true }),
    draft('mop-cfg', 'chorePolicy', 'mop', { configuration: seeds()[3].payload.configuration })]);
  await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'day', target: day(date), confirmHighLoad: true });
}

test('v2 approving a date rechecks newly increased load without silently skipping its confirmation', async () => {
  const f = await decisionFixture();
  try {
    await highLoad(f, '2026-10-31');
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'approve'), (error) => error.reason === 'highLoad');
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    await f.a.actions.decide(f.request.operationId, 'approve', null, null, { confirmHighLoad: true }); await f.deliver(f.owner);
    assert.equal((await f.b.readModel(range)).requests[0].kind, 'approved');
  } finally { f.close(); }
});

test('v2 a counteroffers new day and its affected members consent both require load confirmation', async () => {
  const f = await decisionFixture();
  try {
    await highLoad(f, '2026-11-01');
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'counteroffer', day('2026-11-01')), (error) => error.reason === 'highLoad');
    const [offer] = await f.a.actions.decide(f.request.operationId, 'counteroffer', day('2026-11-01'), null, { confirmHighLoad: true }); await f.deliver(f.owner);
    await assert.rejects(f.b.actions.decide(f.request.operationId, 'acceptCounteroffer', null, offer.operationId), (error) => error.reason === 'highLoad');
    await f.b.actions.decide(f.request.operationId, 'acceptCounteroffer', null, offer.operationId, { confirmHighLoad: true }); await f.deliver(f.member);
    assert.equal((await f.a.readModel(range)).requests[0].kind, 'approved');
  } finally { f.close(); }
});

test('v2 counteroffers at the same instant with different recent-work conditions cannot borrow each others consent', async () => {
  const f = await requestFixture(); const target = day('2026-11-01');
  const ordinary = f.decide('owner', 'counteroffer', { target, observed: [f.request] });
  f.decide('owner2', 'counteroffer', { target, observed: [f.request], allowDuringCooldown: true });
  f.decide('a', 'acceptCounteroffer', { referenceDecisionId: ordinary.operation.operationId, observed: [f.request, ordinary] });
  const result = f.state(); assert.equal(result.kind, 'conflict'); assert.equal(result.formalOptions, null);
  assert.equal(approvedRequestRule(f.request.operation, result, { timeZone: 'Asia/Tokyo', ruleVersion: 1 }), null);
  const ordinaryId = approvedRequestRuleId(f.request.operation, target);
  const exceptionId = approvedRequestRuleId(f.request.operation, target, { ...f.request.operation.payload.proposedOptions, allowDuringCooldown: true });
  assert.notEqual(ordinaryId, exceptionId);
  for (const decisions of [[...f.decisions].reverse(), [...f.decisions, f.decisions[1]]]) {
    const state = f.state({ decisions }); assert.equal(state.kind, 'conflict'); assert.deepEqual(state.conflictIds, result.conflictIds);
  }
});

test('v2 recent-work exceptions cannot be appended to approvals or authored by a member as a counteroffer', async () => {
  const f = await decisionFixture();
  try {
    const before = (await listSharingOutbox(f.member.database, groupId)).length;
    await assert.rejects(f.member.repository.commit([draft('member-exception', 'requestDecision', 'member-exception', {
      requestId: f.request.operationId, decision: 'counteroffer', target: day('2026-11-01'), referenceDecisionId: null, allowDuringCooldown: true,
    })]), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
    for (const [decision, flag] of [['approve', true], ['counteroffer', false]]) await assert.rejects(f.owner.repository.commit([draft(`invalid-${decision}`, 'requestDecision', `invalid-${decision}`, {
      requestId: f.request.operationId, decision, target: decision === 'counteroffer' ? day('2026-11-01') : null, referenceDecisionId: null, allowDuringCooldown: flag,
    })]), /Only a counteroffer may add/);
  } finally { f.close(); }
});

test('v2 an explicitly confirmed recent-work counteroffer preserves its override through consent and a second SQLite', async () => {
  const f = await decisionFixture({ intervalDays: 3, anchorDate: '2026-10-24' });
  try {
    await f.a.actions.complete({ ...ref, anchorDate: '2026-10-24' }); await f.deliver(f.owner);
    const history = (await f.a.readModel(range)).plan.history;
    const target = day('2026-10-28');
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'counteroffer', target), (error) => error.reason === 'recentWork');
    const [offer] = await f.a.actions.decide(f.request.operationId, 'counteroffer', target, null, { confirmRecentWork: true });
    assert.equal(offer.payload.allowDuringCooldown, true);
    assert.equal(Object.hasOwn(offer.payload, 'confirmRecentWork'), false);
    await f.deliver(f.owner);
    await f.b.actions.decide(f.request.operationId, 'acceptCounteroffer', null, offer.operationId, { confirmRecentWork: true }); await f.deliver(f.member);
    for (const controller of [f.a, f.b]) {
      const model = await controller.readModel(range); assert.equal(model.requests[0].kind, 'approved');
      const subject = model.plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate && entry.choreId === 'floor').subjects[0];
      assert.equal(subject.formalDate.allowDuringCooldown, true); assert.equal(subject.cooldownSuppressed, false);
      assert.deepEqual(model.plan.history, history);
    }
  } finally { f.close(); }
});
