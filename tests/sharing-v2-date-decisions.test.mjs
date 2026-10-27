import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { groupId, draft, seeds } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

import { decisionFixture, range, ref } from './helpers/sharing-v2-decision-fixture.mjs';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { v2DateDecisionReview, v2DateDecisionReviews } from '../src/features/sharing/v2/decision-review.ts';

test('v2 a stale approval cannot silently acknowledge a counteroffer that arrived after the displayed request', async () => {
  const f = await decisionFixture();
  try {
    await f.a.actions.decide(f.request.operationId, 'counteroffer', { precision: 'date', date: '2026-11-01' });
    const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'approve', null, null,
      { expectedDecisionIds: [] }), { code: 'sharing/v2-stale-settings' });
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    assert.equal((await f.a.readModel(range)).requests[0].kind, 'awaiting');
  } finally { f.close(); }
});

test('v2 approval rechecks a fixed overlap introduced after the request instead of scheduling two chores for its assignee', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    const configuration = seeds()[3].payload.configuration; configuration.policy = chorePolicyFromPreset('assigned', ['member']);
    await f.owner.repository.commit([draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true }), draft('mop-cfg', 'chorePolicy', 'mop', { configuration })]);
    await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'fixed', target: f.request.payload.proposed, confirmHighLoad: true });
    const model = await f.a.readModel(range); const before = (await listSharingOutbox(f.owner.database, groupId)).length;
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'approve', null, null,
      { expectedReviewRevision: model.requestReviews[0].revision }), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
    assert.equal((await f.a.readModel(range)).requests[0].kind, 'awaiting');
  } finally { f.close(); }
});

test('v2 decision guards are checked after acquiring the SQLite transaction rather than before a queued counteroffer', async () => {
  const f = await decisionFixture();
  try {
    const offer = f.a.actions.decide(f.request.operationId, 'counteroffer', { precision: 'date', date: '2026-11-01' });
    const stale = f.a.actions.decide(f.request.operationId, 'approve', null, null, { expectedDecisionIds: [] });
    const results = await Promise.allSettled([offer, stale]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[1].reason.code, 'sharing/v2-stale-settings');
    assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 1);
  } finally { f.close(); }
});

test('v2 accepting a counteroffer rechecks later fixed schedules and leaves its old formal date intact on rejection', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    const target = { precision: 'interval', start: '2026-10-27T12:00:00.000Z', end: '2026-10-27T12:30:00.000Z' };
    const [offer] = await f.a.actions.decide(f.request.operationId, 'counteroffer', target); await f.deliver(f.owner);
    const configuration = seeds()[3].payload.configuration; configuration.policy = chorePolicyFromPreset('assigned', ['member']);
    await f.owner.repository.commit([draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true }), draft('mop-cfg', 'chorePolicy', 'mop', { configuration })]);
    await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'fixed', target, confirmHighLoad: true }); await f.deliver(f.owner);
    const before = (await listSharingOutbox(f.member.database, groupId)).length;
    await assert.rejects(f.b.actions.decide(f.request.operationId, 'acceptCounteroffer', null, offer.operationId), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
    const request = (await f.b.readModel(range)).requests[0]; assert.equal(request.kind, 'counteroffered'); assert.deepEqual(request.formal, f.request.payload.original);
  } finally { f.close(); }
});

test('v2 approval rechecks allow adjacent time slots and different assignees instead of blocking all same-day work', async () => {
  for (const [assignee, start, end] of [['member', '11:30', '12:00'], ['owner', '11:00', '11:30']]) {
    const f = await decisionFixture({ fixed: true });
    try {
      const configuration = seeds()[3].payload.configuration; configuration.policy = chorePolicyFromPreset('assigned', [assignee]);
      await f.owner.repository.commit([draft('mop', 'chore', 'mop', { name: '水拭き', enabled: true }), draft('mop-cfg', 'chorePolicy', 'mop', { configuration })]);
      await f.a.actions.changeDate({ ...ref, choreId: 'mop' }, { mode: 'fixed', target: { precision: 'interval', start: `2026-10-27T${start}:00.000Z`, end: `2026-10-27T${end}:00.000Z` }, confirmHighLoad: true });
      await f.a.actions.decide(f.request.operationId, 'approve'); await f.deliver(f.owner);
      assert.equal((await f.a.readModel(range)).requests[0].kind, 'approved'); assert.equal((await f.b.readModel(range)).requests[0].kind, 'approved');
    } finally { f.close(); }
  }
});

test('v2 a displayed decision revision cannot be reused after ownership, timezone, cadence or assignment changes', async () => {
  for (const change of ['owner', 'zone', 'cycle', 'assignment']) {
    const f = await decisionFixture();
    try {
      const before = (await f.a.readModel(range)).requestReviews[0].revision;
      if (change === 'owner') f.archive.push(transferSharedOwnership(f.archive.at(-1), f.owner.options.identity,
        { userId: 'member', deviceId: f.member.options.identity.deviceId }));
      if (change === 'zone') await f.owner.repository.commit([draft('new-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]);
      if (change === 'cycle') await f.a.actions.patchChoreConfiguration('floor', 1, { windowAfterDays: 3 }, '2026-10-27');
      if (change === 'assignment') await f.a.actions.assign(ref, ['member'], 'this', true);
      const count = (await listSharingOutbox(f.owner.database, groupId)).length;
      await assert.rejects(f.a.actions.decide(f.request.operationId, 'approve', null, null, { expectedReviewRevision: before }), { code: 'sharing/v2-stale-settings' });
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, count);
      if (change === 'owner') {
        assert.equal((await f.a.readModel(range)).requestReviews[0].canVote, false);
        assert.equal((await f.b.readModel(range)).requestReviews[0].canVote, true);
      }
    } finally { f.close(); }
  }
});

test('v2 date approval cannot violate a required order introduced after the request but rejecting the request remains possible', async () => {
  const f = await decisionFixture({ fixed: true });
  try {
    await f.owner.repository.commit([draft('prepare', 'chore', 'prepare', { name: '準備', enabled: true }),
      draft('prepare-cfg', 'chorePolicy', 'prepare', { configuration: seeds()[3].payload.configuration })]);
    await f.a.actions.changeDate({ ...ref, choreId: 'prepare' }, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    await f.owner.repository.commit([draft('required-order', 'dependency', 'required-order', {
      predecessorChoreId: 'prepare', successorChoreId: 'floor', policyData: { required: true },
    })]);
    await assert.rejects(f.a.actions.decide(f.request.operationId, 'approve'), { code: 'sharing/v2-authority-denied' });
    await f.a.actions.decide(f.request.operationId, 'reject'); await f.deliver(f.owner);
    assert.equal((await f.b.readModel(range)).requests[0].kind, 'rejected');
    assert.equal((await f.b.readModel(range)).plan.history.length, 0);
  } finally { f.close(); }
});

test('v2 batch decision guards match single-request guards and unrelated cosmetic edits cannot stop a reviewed answer', async () => {
  const f = await decisionFixture();
  try {
    await f.b.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-11-02' } }); await f.deliver(f.member);
    let state = await f.owner.repository.readState(); const batch = v2DateDecisionReviews(state, 'owner'); assert.equal(batch.length, 2);
    for (const entry of batch) assert.deepEqual(entry, v2DateDecisionReview(state, entry.requestId, 'owner'));
    const [other] = await f.a.actions.addChore('別の家事'); await f.a.actions.patchChore(other.entityId, { name: '別の家事の新しい名前' });
    state = await f.owner.repository.readState(); assert.deepEqual(v2DateDecisionReviews(state, 'owner'), batch);
    await f.a.actions.decide(f.request.operationId, 'approve', null, null, { expectedReviewRevision: batch.find((entry) => entry.requestId === f.request.operationId).revision });
    assert.equal((await f.owner.repository.readState()).assessment.view.ofType('requestDecision').length, 1);
  } finally { f.close(); }
});

test('v2 a thousand projected request cards keep source traversals bounded instead of rescanning the group per card', async () => {
  const f = await decisionFixture();
  try {
    const source = await f.owner.repository.readState(); const actual = source.assessment.requestStates[0];
    for (const count of [100, 1000]) {
      let traversals = 0; const view = Object.create(source.assessment.view);
      Object.defineProperty(view, 'ready', { get() { traversals++; return source.assessment.view.ready; } });
      // This stresses already-projected UI states, not authentication or receipt verification.
      const state = { ...source, assessment: { ...source.assessment, view, requestStates: Array.from({ length: count }, (_, index) => ({ ...actual, requestId: `projected-${index}` })) } };
      const entries = v2DateDecisionReviews(state, 'owner'); assert.equal(entries.length, count); assert.ok(traversals <= 4, `source traversed ${traversals} times for ${count} cards`);
      assert.equal(new Set(entries.map((entry) => entry.revision)).size, count);
    }
  } finally { f.close(); }
});
