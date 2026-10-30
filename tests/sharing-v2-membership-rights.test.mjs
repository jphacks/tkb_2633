import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, removeSharedMembers } from '../src/features/sharing/roster.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2MembershipStart } from '../src/features/sharing/v2/membership-period.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
const rights = { enabled: true, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } };
const ids = field => field.candidates.map(candidate => candidate.operationId);
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `membership-${d.options.identity.deviceId}-${++n}`, now, sync: async () => {} }); }
const source = c => c.readModel(range, { permissionsChoreId: 'floor' });
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup() {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  const initial = seeds(); initial[3].payload.configuration.policy = { completion: 'one', assignment: { mode: 'selected', memberIds: ['owner'] } };
  await owner.repository.commit(initial); const a = controller(owner); const b = controller(member); const current = await source(a);
  await a.actions.editDateRights('floor', [{ userId: 'member', value: rights, basisOperationIds: [], expectedMembershipStart: current.dateRights.membershipStarts.member }], ids(current.groupPolicy));
  await receive(owner, await loadSharedFacts(owner.database, groupId)); await receive(member, await loadSharedFacts(owner.database, groupId));
  return { f, owner, member, a, b, close: () => { owner.connection.close(); member.connection.close(); } };
}

test('v2 membership periods preserve continuous users across device changes and invalidate an appended removal and rejoin', async () => {
  const f = await fixture(); const extra = await createDeviceIdentity(sharingTestCrypto);
  assert.equal(v2MembershipStart(f.archive, 'owner', 1), 1); assert.equal(v2MembershipStart(f.archive, 'member', 1), null);
  assert.equal(v2MembershipStart(f.archive, 'member', 2), 2);
  f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'member', extra));
  assert.equal(v2MembershipStart(f.archive, 'member', 3), 2);
  f.archive.push(removeSharedMembers(f.archive.at(-1), f.owner, ['member']));
  assert.equal(v2MembershipStart(f.archive, 'member', 4), null); assert.equal(v2MembershipStart(f.archive, 'member', 2), 2);
  f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'member', f.member));
  assert.equal(v2MembershipStart(f.archive, 'member', 5), 5); assert.equal(v2MembershipStart(f.archive, 'member', 3), 2);
  assert.equal(v2MembershipStart(f.archive, 'owner', 5), 1); assert.equal(v2MembershipStart(f.archive, 'unknown', 5), null);
  assert.equal(v2MembershipStart(f.archive, 'member', 6), null);
  for (const invalid of [NaN, Infinity, 0, -1, 1.5]) assert.equal(v2MembershipStart(f.archive, 'owner', invalid), null);
});

test('v2 rejoining does not resurrect old delegated rights and a new grant preserves the formerly authorized shared instruction', async () => {
  const f = await setup();
  try {
    const original = await f.b.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    assert.equal(original[0].entityType, 'designation'); await receive(f.owner, await loadSharedFacts(f.member.database, groupId));
    f.f.archive.push(removeSharedMembers(f.f.archive.at(-1), f.f.owner, ['member']));
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'member', f.f.member));
    let current = await source(f.a); assert.equal(current.dateRights.membershipStarts.member, 4); assert.equal(current.dateRights.fields.member.kind, 'missing');
    assert.ok((await f.owner.repository.readState()).assessment.view.ready.some(operation => operation.operationId === original[0].operationId));
    const after = await f.b.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-29' } });
    assert.equal(after[0].entityType, 'changeRequest');
    current = await source(f.a);
    await f.a.actions.editDateRights('floor', [{ userId: 'member', value: rights, basisOperationIds: [], expectedMembershipStart: current.dateRights.membershipStarts.member }], ids(current.groupPolicy));
    await receive(f.member, await loadSharedFacts(f.owner.database, groupId));
    const reauthorized = await f.b.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-27' } });
    assert.equal(reauthorized[0].entityType, 'designation'); assert.equal(reauthorized[0].keyVersion, 4);
    const grantFacts = (await loadSharedFacts(f.owner.database, groupId)).filter(fact => fact.operation.entityType === 'datePermission');
    assert.deepEqual(grantFacts.map(fact => fact.operation.keyVersion), [2, 4]);
  } finally { f.close(); }
});

test('v2 another device and another member do not revoke an uninterrupted user delegation', async () => {
  const f = await setup(); const extra = await createDeviceIdentity(sharingTestCrypto); const newcomer = await createDeviceIdentity(sharingTestCrypto);
  let added;
  try {
    const original = await source(f.a); f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'member', extra));
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'new-member', newcomer));
    const current = await source(f.a); assert.equal(current.dateRights.membershipStarts.member, 2);
    assert.deepEqual(current.dateRights.fields.member, original.dateRights.fields.member);
    const changed = await f.b.actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } }); assert.equal(changed[0].entityType, 'designation');
    added = await f.f.device('member', extra); await receive(added, await loadSharedFacts(f.owner.database, groupId));
    const fromAddedDevice = await controller(added).actions.changeDate(ref, { mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
    assert.equal(fromAddedDevice[0].entityType, 'designation'); assert.equal(fromAddedDevice[0].authorDeviceId, extra.deviceId);
    const saved = await f.a.actions.editDateRights('floor', [{ userId: 'member', value: { ...rights, enabled: false }, basisOperationIds: ids(original.dateRights.fields.member), expectedMembershipStart: 2 }], ids(original.groupPolicy));
    assert.equal(saved.operations.length, 1);
  } finally { added?.connection.close(); f.close(); }
});

test('v2 a permission editor from a former membership cannot grant even with an empty field base and unchanged group policy', async () => {
  const f = await setup();
  try {
    const old = await source(f.a); f.f.archive.push(removeSharedMembers(f.f.archive.at(-1), f.f.owner, ['member']));
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'member', f.f.member)); const before = await listSharingOutbox(f.owner.database, groupId);
    for (const basisOperationIds of [[], ids(old.dateRights.fields.member)]) {
      await assert.rejects(f.a.actions.editDateRights('floor', [{ userId: 'member', value: rights, basisOperationIds, expectedMembershipStart: old.dateRights.membershipStarts.member }], ids(old.groupPolicy)), { code: 'sharing/v2-stale-settings' });
    }
    assert.deepEqual(await listSharingOutbox(f.owner.database, groupId), before); assert.equal((await source(f.a)).dateRights.fields.member.kind, 'missing');
  } finally { f.close(); }
});
