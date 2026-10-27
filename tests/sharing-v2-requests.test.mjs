import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { observedConfirmation } from '../src/features/sharing/v2/request-state.ts';
import { maximalCausalFacts } from '../src/features/sharing/v2/causal-facts.ts';
import { causallyPrecedes } from '../src/features/sharing/operations.ts';
import { fixture, start, hour, date, instant } from './helpers/sharing-v2-request-fixture.mjs';

test('v2 requests keep their original formal date until independent request and decision receipts arrive', async () => {
  const f = await fixture(); const requestReceipt = f.receipts.get('request'); f.receipts.delete('request');
  const vote = f.decide('owner', 'approve', { delivered: false });
  assert.equal(f.state().kind, 'pendingDelivery'); assert.deepEqual(f.state().formal, date('2026-10-30'));
  f.receipts.set('request', requestReceipt); assert.equal(f.state().kind, 'awaiting');
  assert.equal(f.state().decisions[0].kind, 'pendingDelivery');
  f.deliver(vote); const confirmed = f.state(); assert.equal(confirmed.kind, 'approved'); assert.deepEqual(confirmed.formal, date('2026-10-31'));
  assert.equal(f.state({ confirmedServerTime: start + 1000 * hour }).kind, 'approved', 'a timely receipt remains valid after a later device restart');
});
test('v2 request expiry uses receipt time instead of the original offline click time and accepts exactly the boundary', async () => {
  for (const [offset, expected] of [[24 * hour, 'approved'], [24 * hour + 1, 'expired']]) {
    const f = await fixture(); const vote = f.decide('owner', 'approve', { at: start + offset });
    const result = f.state(); assert.equal(result.kind, expected);
    if (expected === 'expired') { assert.equal(result.decisions[0].kind, 'late'); assert.deepEqual(result.formal, result.original); }
    assert.equal(vote.operation.recordedAt, new Date(start + 500).toISOString());
  }
  const awaiting = await fixture(); assert.equal(awaiting.state().kind, 'awaiting');
  assert.equal(awaiting.state({ confirmedServerTime: start + 24 * hour + 1 }).kind, 'expired');
});
test('v2 requests at or inside one hour cannot become automatically approved when an offline request arrives late', async () => {
  const f = await fixture({ mode: 'deadline', original: instant(1), proposed: instant(1), approval: { kind: 'allowed', needsRequest: true, automaticallyApproved: true } });
  assert.equal(f.state().kind, 'tooLate'); assert.equal(f.state().confirmation, null); assert.deepEqual(f.state().formal, f.state().original);
});
test('v2 automatic approval retains a receipt-backed audit fact and explicit deadline options without a fabricated decision', async () => {
  const f = await fixture({ mode: 'deadline', original: instant(120), proposed: instant(110),
    approval: { kind: 'allowed', needsRequest: true, automaticallyApproved: true } });
  const result = f.state(); assert.equal(result.kind, 'approved'); assert.deepEqual(result.formal, instant(110));
  assert.equal(result.proposal.proposedMode, 'deadline'); assert.equal(result.proposal.proposedOptions.strict, true);
  assert.equal(result.confirmation.operationId, 'request'); assert.equal(f.decisions.length, 0);
});
test('v2 roommate requests require every affected assignee and do not accept an administrator self-approval', async () => {
  const f = await fixture({ assigneeIds: ['a', 'b'], approval: { kind: 'approvalRequired', approver: 'assignee', reason: 'othersAssignment' } });
  f.decide('owner', 'approve'); assert.equal(f.state().kind, 'awaiting'); assert.equal(f.state().decisions[0].kind, 'unauthorized');
  const a = f.decide('a', 'approve'); assert.equal(f.state().kind, 'awaiting');
  const b = f.decide('b', 'approve'); const state = f.state(); assert.equal(state.kind, 'approved');
  const partial = { context: { ...b.operation.context, [b.operation.authorDeviceId]: b.operation.deviceSequence - 1 } };
  assert.equal(observedConfirmation(state.confirmation, partial), false);
  const all = { context: { ...b.operation.context, [b.operation.authorDeviceId]: b.operation.deviceSequence } };
  assert.equal(observedConfirmation(state.confirmation, all), true); assert.ok(all.context[a.operation.authorDeviceId] >= a.operation.deviceSequence);
});
test('v2 contradictory concurrent votes stay a conflict in every receive order and an explicit causal resolution can settle them', async () => {
  const f = await fixture({ assigneeIds: ['a'], approval: { kind: 'approvalRequired', approver: 'assignee', reason: 'othersAssignment' } });
  const approve = f.decide('a', 'approve', { observed: [f.request] });
  const reject = f.decide('a2', 'reject', { observed: [f.request], at: start + 2000 });
  for (const decisions of [[approve, reject], [reject, approve], [reject, approve, approve]]) {
    const state = f.state({ decisions }); assert.equal(state.kind, 'conflict'); assert.deepEqual(state.formal, state.original);
    assert.deepEqual(state.conflictIds, [approve.operation.operationId, reject.operation.operationId]);
  }
  f.decide('a', 'approve'); assert.equal(f.state().kind, 'approved');
});
test('v2 an accepted administrator counteroffer confirms once without asking that administrator a second time', async () => {
  const f = await fixture(); const offer = f.decide('owner', 'counteroffer', { target: date('2026-11-01') });
  assert.equal(f.state().kind, 'counteroffered'); assert.deepEqual(f.state().formal, f.state().original);
  const accept = f.decide('a', 'acceptCounteroffer', { referenceDecisionId: offer.operation.operationId });
  const result = f.state(); assert.equal(result.kind, 'approved'); assert.deepEqual(result.formal, date('2026-11-01'));
  assert.equal(observedConfirmation(result.confirmation, { context: accept.operation.context }), false);
  assert.equal(observedConfirmation(result.confirmation, { context: { ...accept.operation.context,
    [accept.operation.authorDeviceId]: accept.operation.deviceSequence } }), true);
});
test('v2 counteroffer consent belongs to the actual affected member instead of its administrator or another requester', async () => {
  const f = await fixture({ assigneeIds: ['b'], approval: { kind: 'approvalRequired', approver: 'assignee', reason: 'othersAssignment' } });
  const offer = f.decide('owner', 'counteroffer', { target: date('2026-11-01') });
  f.decide('owner', 'acceptCounteroffer', { referenceDecisionId: offer.operation.operationId });
  f.decide('a', 'acceptCounteroffer', { referenceDecisionId: offer.operation.operationId });
  assert.equal(f.state().kind, 'counteroffered');
  f.decide('b', 'acceptCounteroffer', { referenceDecisionId: offer.operation.operationId }); assert.equal(f.state().kind, 'approved');
});
test('v2 earlier counteroffers shorten the consent limit and later alternatives cannot extend the original request expiry', async () => {
  for (const [targetHours, acceptedHours, expected] of [[5, 1, 'approved'], [5, 1.001, 'counteroffered'], [150, 24.001, 'expired']]) {
    const f = await fixture({ mode: 'deadline', original: instant(120), proposed: instant(130) });
    const offer = f.decide('owner', 'counteroffer', { target: instant(targetHours), at: start + 500 });
    f.decide('a', 'acceptCounteroffer', { referenceDecisionId: offer.operation.operationId, at: start + Math.round(acceptedHours * hour) });
    const result = f.state(); assert.equal(result.kind, expected);
    if (expected !== 'approved') assert.equal(result.decisions.at(-1).kind, 'late');
    assert.equal(result.counteroffers[0]?.expiresAt, start + Math.min(targetHours === 5 ? 1 : 24, 24) * hour);
  }
});
test('v2 a causal answer after a completed request cannot silently reverse its accepted or rejected outcome', async () => {
  for (const first of ['approve', 'reject']) {
    const f = await fixture(); const answer = f.decide('owner', first);
    f.decide('owner', first === 'approve' ? 'reject' : 'approve');
    const state = f.state(); assert.equal(state.kind, first === 'approve' ? 'approved' : 'rejected');
    assert.equal(state.decisions.at(-1).kind, 'requestClosed'); assert.equal(state.decisions[0].operationId, answer.operation.operationId);
  }
});
test('v2 a concurrent replacement offer and acceptance expose review instead of selecting the last server upload', async () => {
  const f = await fixture(); const first = f.decide('owner', 'counteroffer', { target: date('2026-11-01') });
  const second = f.decide('owner', 'counteroffer', { target: date('2026-11-02'), observed: [f.request, first] });
  const accept = f.decide('a', 'acceptCounteroffer', { referenceDecisionId: first.operation.operationId, observed: [f.request, first] });
  for (const decisions of [[first, second, accept], [accept, second, first]]) {
    const result = f.state({ decisions }); assert.equal(result.kind, 'conflict'); assert.deepEqual(result.formal, result.original);
  }
  const g = await fixture(); const old = g.decide('owner', 'counteroffer', { target: date('2026-11-01') });
  g.decide('owner', 'counteroffer', { target: date('2026-11-02') });
  g.decide('a', 'acceptCounteroffer', { referenceDecisionId: old.operation.operationId });
  assert.equal(g.state().kind, 'counteroffered'); assert.equal(g.state().decisions.at(-1).kind, 'staleCounteroffer');
});
test('v2 request decisions use the administrator at server receipt and retain independent original author binding', async () => {
  const f = await fixture(); const old = f.decide('owner', 'approve', { delivered: false });
  f.archive.push(transferSharedOwnership(f.archive.at(-1), f.identities.owner, { userId: 'b', deviceId: f.identities.b.deviceId }));
  f.deliver(old); assert.equal(f.state().kind, 'awaiting'); assert.equal(f.state().decisions[0].kind, 'unauthorized');
  f.decide('b', 'approve'); assert.equal(f.state().kind, 'approved');
  const receipt = f.receipts.get('request'); f.receipts.set('request', { ...receipt, authorProofDigest: '0'.repeat(64) });
  assert.throws(() => f.state(), /author proof/);
});
test('v2 equivalent simultaneous approvals retain alternative compact proofs without choosing an arbitrary approving device', async () => {
  const f = await fixture(); const a = f.decide('owner', 'approve', { observed: [f.request] });
  const b = f.decide('owner2', 'approve', { observed: [f.request] });
  const result = f.state(); assert.equal(result.kind, 'approved');
  for (const vote of [a, b]) assert.equal(observedConfirmation(result.confirmation,
    { context: { ...vote.operation.context, [vote.operation.authorDeviceId]: vote.operation.deviceSequence } }), true);
  assert.equal(observedConfirmation(result.confirmation, { context: { [f.identities.a.deviceId]: 1 } }), false);
});
test('v2 causal maxima retain the pairwise semantics including duplicate facts and self context without quadratic pair scans', () => {
  let seed = 0x7321;
  const random = (n) => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  for (let run = 0; run < 120; run++) {
    const facts = Array.from({ length: 1 + random(70) }, (_, i) => ({ operationId: `op-${String(i).padStart(3, '0')}`, authorDeviceId: `d-${random(8)}`,
      deviceSequence: 1 + random(40), context: Object.fromEntries(Array.from({ length: 8 }, (_, device) => [`d-${device}`, random(40)])) }));
    const expected = facts.filter((fact) => !facts.some((other) => fact !== other && causallyPrecedes(fact, other))).map((fact) => fact.operationId).sort();
    assert.deepEqual(maximalCausalFacts([...facts, facts[0]]).map((fact) => fact.operationId), expected);
  }
});

test('v2 a different assignee veto rejects the request while contradictory votes by the same assignee require review', async () => {
  const f = await fixture({ assigneeIds: ['a', 'b'], approval: { kind: 'approvalRequired', approver: 'assignee', reason: 'othersAssignment' } });
  f.decide('a', 'reject', { observed: [f.request] }); f.decide('b', 'approve', { observed: [f.request] });
  assert.equal(f.state().kind, 'rejected'); assert.deepEqual(f.state().formal, f.state().original);
});
test('v2 confirmation evidence cannot be vacuously true without a real positive operation dot', () => {
  const at = { context: {} };
  for (const proof of [{ kind: 'all', entries: [] }, { kind: 'any', entries: [] },
    { kind: 'operation', operationId: 'missing', authorDeviceId: 'device', deviceSequence: 0 }]) {
    assert.throws(() => observedConfirmation(proof, at), /confirmation/);
  }
});
test('v2 request state and civil date deadlines are identical under iOS and Android device timezone settings', async () => {
  const f = await fixture(); f.decide('owner', 'approve'); const expected = f.state(); const original = process.env.TZ;
  try {
    for (const zone of ['UTC', 'Asia/Tokyo', 'America/New_York', 'Pacific/Honolulu']) {
      process.env.TZ = zone; assert.deepEqual(f.state(), expected);
    }
  } finally { if (original === undefined) delete process.env.TZ; else process.env.TZ = original; }
});
test('v2 a long counteroffer history keeps every audit fact but only its causal current alternative without proof multiplication', async () => {
  const f = await fixture(); let last;
  for (let i = 0; i < 256; i++) last = f.decide('owner', 'counteroffer', { target: date(i % 2 ? '2026-11-01' : '2026-11-02') });
  const state = f.state(); assert.equal(state.kind, 'counteroffered'); assert.equal(state.decisions.length, 256);
  assert.equal(state.counteroffers.length, 1); assert.equal(state.counteroffers[0].operationId, last.operation.operationId);
  assert.ok(state.decisions.every((decision) => decision.kind === 'eligible'));
});
