import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { approvedRequestRule, observedManualRule, maximalManualRules } from '../src/features/sharing/v2/formal-rules.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { fixture, date } from './helpers/sharing-v2-request-fixture.mjs';

const derived = (f) => approvedRequestRule(f.request.operation, f.state(), { timeZone: 'Asia/Tokyo', ruleVersion: 1 });
const frame = { id: 'frame', choreId: 'floor', anchorDate: '2026-10-30', ruleVersion: 1, windowStart: '2026-10-28', windowEnd: '2026-11-01' };
function directAfter(f, vote, extra = {}) {
  const approved = derived(f); return { operationId: 'direct', authorDeviceId: f.identities.a.deviceId, deviceSequence: 2,
    context: { [f.identities.a.deviceId]: 1, ...(vote ? { [vote.operation.authorDeviceId]: vote.operation.deviceSequence } : {}) },
    rule: { ...approved.rule, id: 'direct', target: date('2026-11-02'), basisRuleIds: [], ...extra } };
}

test('v2 pending requests have no formal rule and an approved rule requires the complete confirmation instead of its request dot', async () => {
  const f = await fixture(); assert.equal(derived(f), null);
  const vote = f.decide('owner', 'approve'); const rule = derived(f);
  assert.match(rule.operationId, /^v2-rule-[a-f0-9]{64}$/u); assert.equal(rule.sourceRequestId, 'request');
  assert.equal(observedManualRule(rule, { context: { [f.identities.a.deviceId]: 1 } }), false);
  assert.equal(observedManualRule(rule, { context: { ...vote.operation.context, [vote.operation.authorDeviceId]: vote.operation.deviceSequence } }), true);
  assert.deepEqual(rule.context, f.request.operation.context, 'the later decision context must not rewrite the original proposal causal basis');
});
test('v2 approved rule identities stay stable as equivalent simultaneous confirmation proofs arrive', async () => {
  const f = await fixture(); const first = f.decide('owner', 'approve', { observed: [f.request] }); const before = derived(f);
  f.decide('owner2', 'approve', { observed: [f.request] }); const after = derived(f);
  assert.equal(before.operationId, after.operationId); assert.deepEqual(before.rule, after.rule);
  assert.equal(observedManualRule(after, { context: { ...first.operation.context, [first.operation.authorDeviceId]: first.operation.deviceSequence } }), true);
});
test('v2 observing only a pending request cannot make a direct date change silently supersede its later approved rule', async () => {
  const f = await fixture(); f.decide('owner', 'approve'); const approved = derived(f);
  const unaware = directAfter(f, null, { basisRuleIds: [approved.operationId] });
  for (const rules of [[approved, unaware], [unaware, approved]]) {
    assert.equal(selectManualRule(rules, frame, null, 'Asia/Tokyo').kind, 'conflict');
  }
});
test('v2 replacing an approved date requires both its explicit semantic basis and observed confirmation evidence', async () => {
  const f = await fixture(); const vote = f.decide('owner', 'approve'); const approved = derived(f);
  const missingBasis = directAfter(f, vote); assert.equal(selectManualRule([approved, missingBasis], frame, null, 'Asia/Tokyo').kind, 'conflict');
  const replacement = directAfter(f, vote, { basisRuleIds: [approved.operationId] });
  const selected = selectManualRule([approved, replacement], frame, null, 'Asia/Tokyo');
  assert.equal(selected.kind, 'selected'); assert.equal(selected.fact.operationId, 'direct');
  assert.equal(maximalManualRules([replacement, approved])[0].operationId, 'direct');
});
test('v2 an approval that later observes a competing direct date cannot retroactively suppress a change unseen by its original request', async () => {
  const f = await fixture();
  const plain = { operationId: 'plain', authorDeviceId: f.identities.b.deviceId, deviceSequence: 1, context: {},
    rule: { id: 'plain', choreId: 'floor', subjectUserId: null, selector: { scope: 'once', occurrenceId: 'frame', anchorDate: frame.anchorDate },
      referenceAnchorDate: frame.anchorDate, timeZoneAtCreation: 'Asia/Tokyo', mode: 'day', target: date('2026-11-02'),
      strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'b', ruleVersion: 1 } };
  // The proof's approver may have observed this direct change, but the request itself did not.
  f.decide('owner', 'approve', { observed: [f.request, { operation: { ...plain, logicalClock: 2 } }] });
  const approved = derived(f); assert.equal(selectManualRule([plain, approved], frame, null, 'Asia/Tokyo').kind, 'conflict');
});
test('v2 a derived date retains the explicit mode, recurring selector and authoring timezone instead of inventing a signed event', async () => {
  const f = await fixture(); const vote = f.decide('owner', 'approve'); const rule = derived(f);
  assert.equal(rule.rule.mode, 'day'); assert.equal(rule.rule.timeZoneAtCreation, 'Asia/Tokyo'); assert.deepEqual(rule.rule.selector, f.request.operation.payload.selector);
  assert.equal(rule.rule.issuerUserId, f.request.operation.authorUserId); assert.equal(rule.rule.referenceAnchorDate, frame.anchorDate);
  assert.ok(!Object.hasOwn(rule, 'authorSignature')); assert.notEqual(rule.operationId, vote.operation.operationId);
  assert.deepEqual(f.request.operation.payload.original, date('2026-10-30'));
});
