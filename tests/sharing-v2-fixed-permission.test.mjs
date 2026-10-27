import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { loadSharedFacts, applyReceivedSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';

const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const range = { from: '2026-10-27', through: '2026-10-28', asOfDate: '2026-10-27' };
const target = (start, end) => ({ precision: 'interval', start: `2026-10-27T${start}:00.000Z`, end: `2026-10-27T${end}:00.000Z` });
async function fixedFixture({ policy = {}, options = {} } = {}) {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  const actions = (d) => { let id = 0; return createV2PlannerActions(d.repository, { makeId: () => `${d.options.userId}-fixed-${++id}`, now }); };
  const a = actions(owner); const b = actions(member);
  const initial = seeds(); Object.assign(initial[0].payload.configuration, policy); initial[3].payload.configuration.policy = chorePolicyFromPreset('assigned', ['member']); await owner.repository.commit(initial);
  const [source] = await a.changeDate(ref, { mode: 'fixed', target: target('10:00', '10:30'), options });
  assert.equal(source.payload.configuration.adminLocked, false); assert.equal(source.payload.configuration.strict, options.strict === true);
  const deliver = async (facts, cursor) => { for (const d of [owner, member]) {
    const before = await readSharingCheckpoint(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, facts, String(cursor), d.repository.project, before.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
  } };
  await deliver(await loadSharedFacts(owner.database, groupId), 5);
  return { owner, member, a, b, source, deliver, close() { owner.connection.close(); member.connection.close(); } };
}

test('v2 a fixed-time designation requires consent for a later change even when no extra administrator-lock or strict flag was set', async () => {
  const f = await fixedFixture();
  try {
    const [change] = await f.b.changeDate(ref, { mode: 'fixed', target: target('11:00', '11:30') });
    assert.equal(change.entityType, 'changeRequest');
    await f.deliver(await loadSharedFacts(f.member.database, groupId), 6);
    const state = await f.member.repository.readState(); assert.equal(state.assessment.requestStates[0].kind, 'awaiting');
    assert.deepEqual((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.target, target('10:00', '10:30'));
  } finally { f.close(); }
});

test('v2 an earlier fixed-time change keeps the permitted automatic-approval path but waits for its immutable request receipt', async () => {
  const f = await fixedFixture();
  try {
    const [change] = await f.b.changeDate(ref, { mode: 'fixed', target: target('09:00', '09:30') });
    assert.equal(change.entityType, 'changeRequest');
    assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'pendingDelivery');
    assert.deepEqual((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.target, target('10:00', '10:30'));
    await f.deliver(await loadSharedFacts(f.member.database, groupId), 6);
    assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'approved');
    assert.deepEqual((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.target, target('09:00', '09:30'));
  } finally { f.close(); }
});

test('v2 cancelling a fixed time or dropping its time meaning cannot bypass consent through an unlocked flag or earlier automatic approval', async () => {
  const f = await fixedFixture();
  try {
    await assert.rejects(f.b.cancelDates(ref, [f.source.operationId]), { code: 'sharing/v2-authority-denied' });
    const [change] = await f.b.changeDate(ref, { mode: 'deadline', target: { precision: 'instant', at: '2026-10-27T09:00:00.000Z' } });
    assert.equal(change.entityType, 'changeRequest'); await f.deliver(await loadSharedFacts(f.member.database, groupId), 6);
    assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'awaiting');
    const before = (await listSharingOutbox(f.member.database, groupId)).length;
    await assert.rejects(f.member.repository.commit([draft('direct-fixed-bypass', 'designation', 'direct-fixed-bypass', { configuration: {
      id: 'direct-fixed-bypass', choreId: 'floor', subjectUserId: null, ruleVersion: 1, referenceAnchorDate: ref.anchorDate,
      selector: { scope: 'once', occurrenceId: (await f.b.readPlan(range)).occurrences[0].id, anchorDate: ref.anchorDate }, timeZoneAtCreation: 'Asia/Tokyo',
      mode: 'fixed', target: target('11:00', '11:30'), strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'member', basisRuleIds: [f.source.operationId],
    } })]), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(f.member.database, groupId)).length, before);
  } finally { f.close(); }
});

test('v2 fixed-time automatic approval remains disabled by strict instructions, an earlier-change prohibition or the explicit group setting', async () => {
  for (const settings of [{ options: { strict: true } }, { options: { forbidEarlier: true } }, { policy: { autoApproveEarlier: false } }]) {
    const f = await fixedFixture(settings);
    try {
      const [change] = await f.b.changeDate(ref, { mode: 'fixed', target: target('09:00', '09:30') }); assert.equal(change.entityType, 'changeRequest');
      await f.deliver(await loadSharedFacts(f.member.database, groupId), 6);
      assert.equal((await f.member.repository.readState()).assessment.requestStates[0].kind, 'awaiting');
      assert.deepEqual((await f.b.readPlan(range)).occurrences[0].subjects[0].formalDate.target, target('10:00', '10:30'));
    } finally { f.close(); }
  }
});
