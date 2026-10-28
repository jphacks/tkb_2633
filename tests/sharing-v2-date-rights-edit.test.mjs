import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const plain = { enabled: true, rights: { changeDate: true, changeOthers: false, changeBeforeWindow: false } };
const ids = field => field.candidates.map(candidate => candidate.operationId);
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `rights-${d.options.identity.deviceId}-${++n}`, now, sync: async () => {} }); }
async function source(c, choreId = 'floor') { return c.readModel(range, { permissionsChoreId: choreId }); }
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }

test('v2 per-chore rights keep their original signed bundle and acknowledge only explicitly saved members', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); const ordinary = await c.readModel(range); const before = await source(c);
    assert.equal(ordinary.dateRights, undefined); assert.deepEqual(before.plan, ordinary.plan);
    assert.equal(before.dateRights.fields.member.kind, 'missing'); assert.equal(Object.hasOwn(before.dateRights.fields, 'owner'), false);
    const saved = await c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(before.groupPolicy));
    assert.equal(saved.operations.length, 1); assert.deepEqual(saved.fields.member.value, plain);
    assert.deepEqual(ids(saved.fields.member), [saved.operations[0].operationId]);
    assert.equal(saved.fields.member.candidates[0].recordedAt, saved.operations[0].recordedAt);
    assert.deepEqual(saved.fields.member.candidates[0].context, saved.operations[0].context);
    const current = await source(c); assert.deepEqual(current.dateRights.fields.member, saved.fields.member);
    const noChange = await c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(current.groupPolicy));
    assert.equal(noChange.operations.length, 0); assert.deepEqual(noChange.fields.member, saved.fields.member);
  } finally { d.connection.close(); }
});

test('v2 per-chore rights reject changed group rules foreign bases and invalid batches without partial outbox writes', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); const original = await source(c);
    await c.actions.patchGroupPolicy({ allowSubstitution: false }); const current = await source(c); const before = await listSharingOutbox(d.database, groupId);
    await assert.rejects(c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(original.groupPolicy)), { code: 'sharing/v2-stale-settings' });
    for (const [choreId, edits] of [
      ['floor', [{ userId: 'member', value: plain, basisOperationIds: ['floor'] }]],
      ['another-chore', [{ userId: 'member', value: plain, basisOperationIds: [] }]],
      ['floor', [{ userId: 'member', value: plain, basisOperationIds: [] }, { userId: 'foreign-member', value: plain, basisOperationIds: [] }]],
      ['floor', [{ userId: 'member', value: plain, basisOperationIds: [] }, { userId: 'member', value: plain, basisOperationIds: [] }]],
      ['floor', [{ userId: 'owner', value: plain, basisOperationIds: [] }, { userId: 'member', value: { ...plain, rights: { ...plain.rights, unknown: true } }, basisOperationIds: [] }]],
    ]) await assert.rejects(c.actions.editDateRights(choreId, edits, ids(current.groupPolicy)));
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before); assert.equal((await source(c)).dateRights.fields.member.kind, 'missing');
    const saved = await c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(current.groupPolicy));
    assert.equal(saved.operations[0].deviceSequence, 6);
  } finally { d.connection.close(); }
});

test('v2 disabled delegation blocks new grants while allowing explicit revocation without silently restoring it later', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); let current = await source(c);
    await c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(current.groupPolicy));
    await c.actions.patchGroupPolicy({ delegationEnabled: false }); current = await source(c); const before = await listSharingOutbox(d.database, groupId);
    await assert.rejects(c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: ids(current.dateRights.fields.member) }], ids(current.groupPolicy)), /委譲機能/u);
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    await c.actions.editDateRights('floor', [{ userId: 'member', value: { ...plain, enabled: false }, basisOperationIds: ids(current.dateRights.fields.member) }], ids(current.groupPolicy));
    await c.actions.patchGroupPolicy({ delegationEnabled: true }); current = await source(c);
    assert.equal(current.dateRights.fields.member.value.enabled, false); assert.deepEqual(current.dateRights.fields.member.value.rights, plain.rights);
  } finally { d.connection.close(); }
});

test('v2 concurrent permission and revocation bundles cannot be combined and require an explicit current resolution', async () => {
  const f = await fixture(); const otherIdentity = await createDeviceIdentity(sharingTestCrypto);
  f.archive.push(approveSharedDevice(f.archive.at(-1), f.owner, 'owner', otherIdentity));
  const a = await f.device(); const b = await f.device('owner', otherIdentity);
  try {
    await a.repository.commit(seeds()); await receive(b, await loadSharedFacts(a.database, groupId)); const first = controller(a); const second = controller(b);
    let current = await source(first); const policyIds = ids(current.groupPolicy);
    await first.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], policyIds);
    const revoked = { enabled: false, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } };
    await second.actions.editDateRights('floor', [{ userId: 'member', value: revoked, basisOperationIds: [] }], policyIds);
    await receive(a, await loadSharedFacts(b.database, groupId)); current = await source(first);
    const conflict = current.dateRights.fields.member; assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.candidates.length, 2);
    assert.ok(conflict.candidates.some(candidate => candidate.value.enabled === false));
    const before = await listSharingOutbox(a.database, groupId);
    await assert.rejects(first.actions.editDateRights('floor', [{ userId: 'member', value: { ...revoked, enabled: true }, basisOperationIds: ids(conflict) }], policyIds), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(first.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: ids(conflict), resolveOperationIds: ids(conflict).slice(0, 1) }], policyIds), { code: 'sharing/v2-stale-settings' });
    assert.deepEqual(await listSharingOutbox(a.database, groupId), before);
    await first.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: ids(conflict), resolveOperationIds: ids(conflict) }], policyIds);
    await receive(b, await loadSharedFacts(a.database, groupId)); await receive(a, await loadSharedFacts(b.database, groupId));
    assert.deepEqual((await source(first)).dateRights.fields.member, (await source(second)).dateRights.fields.member);
    assert.deepEqual((await source(second)).dateRights.fields.member.value, plain);
    const facts = await loadSharedFacts(a.database, groupId); assert.equal(facts.filter(fact => fact.operation.entityType === 'datePermission').length, 3);
  } finally { a.connection.close(); b.connection.close(); }
});

test('v2 ordinary members cannot use the checked permission editor to grant themselves rights', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); await receive(member, await loadSharedFacts(owner.database, groupId)); const c = controller(member); const current = await source(c);
    await assert.rejects(c.actions.editDateRights('floor', [{ userId: 'member', value: plain, basisOperationIds: [] }], ids(current.groupPolicy)), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(member.database, groupId)).length, 0); assert.equal((await source(c)).dateRights.fields.member.kind, 'missing');
  } finally { owner.connection.close(); member.connection.close(); }
});
