import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, draft, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, loadSharedFacts, listSharingOutbox, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
function controller(d) { let id = 0; return createV2GroupController(d.repository, { makeId: () => `${d.options.userId}-detail-${++id}`, now, sync: async () => {} }); }
const ids = (field) => field.candidates.map((candidate) => candidate.operationId);
const details = async (c) => (await c.readModel(range, { detailChoreId: 'floor' })).choreDetails.find((row) => row.choreId === 'floor').fields;
async function receive(d, facts) {
  const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts)));
}

test('v2 editable source evidence is loaded only for the requested chore and cannot change its common plan', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); const ordinary = await c.readModel(range);
    const requested = await c.readModel(range, { detailChoreId: 'floor' });
    assert.equal(ordinary.choreDetails.length, 0); assert.equal(requested.choreDetails.length, 1);
    assert.deepEqual(requested.plan, ordinary.plan);
    const foreign = await c.readModel(range, { detailChoreId: 'another-group-chore' }); assert.equal(foreign.choreDetails.length, 0);
    assert.deepEqual(foreign.plan, ordinary.plan);
  } finally { d.connection.close(); }
});

test('v2 detail edits merge unrelated fields and reject a stale overwrite while acknowledging an unchanged current value', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); const base = await details(c);
    await c.actions.patchChoreDetails('floor', [{ field: 'instructions', value: ['別端末の手順'], basisOperationIds: [] }]);
    const saved = await c.actions.patchChoreDetails('floor', [{ field: 'name', value: '新しい床掃除', basisOperationIds: ids(base.name) }]);
    assert.equal(saved.operations.length, 1); assert.equal(saved.fields.name.value, '新しい床掃除');
    assert.deepEqual(ids(saved.fields.name), [saved.operations[0].operationId]); assert.equal(saved.fields.name.candidates[0].recordedAt, now().toISOString());
    assert.deepEqual((await details(c)).instructions.value, ['別端末の手順']); const before = await listSharingOutbox(d.database, groupId);
    await assert.rejects(c.actions.patchChoreDetails('floor', [{ field: 'name', value: '古い画面からの名前', basisOperationIds: ids(base.name) }]), { code: 'sharing/v2-stale-settings' });
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    const duplicate = await c.actions.patchChoreDetails('floor', [{ field: 'name', value: '新しい床掃除', basisOperationIds: ids(base.name) }]);
    assert.equal(duplicate.operations.length, 0); assert.deepEqual(ids(duplicate.fields.name), ids(saved.fields.name));
  } finally { d.connection.close(); }
});

test('v2 detail bases must belong to their authenticated field and cannot reactivate or resurrect a chore', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const c = controller(d); const base = await details(c); const before = await listSharingOutbox(d.database, groupId);
    for (const edits of [
      [{ field: 'name', value: 'invalid', basisOperationIds: ['missing-id'] }],
      [{ field: 'instructions', value: ['invalid'], basisOperationIds: ids(base.name) }],
      [{ field: 'name', value: 'invalid', basisOperationIds: ['policy'] }],
      [{ field: 'name', value: 'invalid', basisOperationIds: [...ids(base.name), ...ids(base.name)] }],
      [{ field: 'name', value: 'first', basisOperationIds: ids(base.name) }, { field: 'name', value: 'second', basisOperationIds: ids(base.name) }],
      [{ field: 'enabled', value: true, basisOperationIds: [] }],
    ]) await assert.rejects(c.actions.patchChoreDetails('floor', edits));
    assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    await d.repository.commit([{ ...draft('delete-floor', 'chore', 'floor', {}), operationType: 'delete' }]);
    await assert.rejects(c.actions.patchChoreDetails('floor', [{ field: 'name', value: 'resurrected', basisOperationIds: ids(base.name) }]), { code: 'sharing/v2-stale-settings' });
    assert.equal((await c.readModel(range)).plan.chores.find((row) => row.id === 'floor').archived, true);
  } finally { d.connection.close(); }
});

test('v2 members can edit shared descriptions and grouped procedures while cadence and enabled rights remain administrator-only', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); await receive(member, await loadSharedFacts(owner.database, groupId));
    const c = controller(member); const base = await details(c);
    const result = await c.actions.patchChoreDetails('floor', [
      { field: 'description', value: '全員が見る説明', basisOperationIds: [] },
      { field: 'procedureSections', value: [{ title: '掃く', steps: ['ほこりを集める', '回収する'] }], basisOperationIds: [] },
      { field: 'name', value: 'みんなの床掃除', basisOperationIds: ids(base.name) },
    ]);
    assert.equal(result.operations.length, 1); assert.equal(result.operations[0].authorUserId, 'member');
    assert.equal((await c.readModel(range)).plan.chores.find((row) => row.id === 'floor').enabled, true);
    const before = await listSharingOutbox(member.database, groupId);
    await assert.rejects(c.actions.patchChore('floor', { enabled: false }), { code: 'sharing/v2-authority-denied' });
    await assert.rejects(c.actions.patchChoreConfiguration('floor', 1, { intervalDays: 3 }, '2026-10-27'), { code: 'sharing/v2-authority-denied' });
    assert.deepEqual(await listSharingOutbox(member.database, groupId), before);
  } finally { owner.connection.close(); member.connection.close(); }
});

test('v2 offline detail conflicts retain both candidates and require a current explicit resolution without stopping another chore', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    const initial = seeds(); initial.push(draft('other-chore', 'chore', 'other', { name: '別の家事', enabled: true }),
      draft('other-policy', 'chorePolicy', 'other', { configuration: { ...initial[3].payload.configuration } }));
    await owner.repository.commit(initial); await receive(member, await loadSharedFacts(owner.database, groupId));
    const a = controller(owner); const b = controller(member); const baseA = await details(a); const baseB = await details(b);
    await a.actions.patchChoreDetails('floor', [{ field: 'name', value: '所有者が書いた名前', basisOperationIds: ids(baseA.name) }]);
    await b.actions.patchChoreDetails('floor', [{ field: 'name', value: 'メンバーが書いた名前', basisOperationIds: ids(baseB.name) }]);
    const union = [...new Map([...(await loadSharedFacts(owner.database, groupId)), ...(await loadSharedFacts(member.database, groupId))].map((fact) => [fact.operation.operationId, fact])).values()];
    await receive(owner, union); await receive(member, [...union].reverse());
    const conflicted = (await details(b)).name; assert.equal(conflicted.kind, 'conflict'); assert.equal(conflicted.candidates.length, 2);
    let model = await b.readModel(range); assert.ok(model.plan.occurrences.some((round) => round.choreId === 'other'));
    assert.equal(model.plan.chores.find((row) => row.id === 'floor').enabled, false);
    await assert.rejects(b.actions.patchChoreDetails('floor', [{ field: 'name', value: '勝手な解決', basisOperationIds: ids(conflicted) }]), { code: 'sharing/v2-stale-settings' });
    await assert.rejects(b.actions.patchChoreDetails('floor', [{ field: 'name', value: '古い解決', basisOperationIds: ids(conflicted), resolveOperationIds: ids(conflicted).slice(0, 1) }]), { code: 'sharing/v2-stale-settings' });
    const resolved = await b.actions.patchChoreDetails('floor', [{ field: 'name', value: '確認して決めた名前', basisOperationIds: ids(conflicted), resolveOperationIds: ids(conflicted) }]);
    assert.equal(resolved.operations.length, 1); await receive(owner, await loadSharedFacts(member.database, groupId));
    assert.equal((await details(a)).name.value, '確認して決めた名前'); assert.deepEqual((await details(a)).name, (await details(b)).name);
    model = await a.readModel(range); assert.equal(model.plan.chores.find((row) => row.id === 'floor').enabled, true);
    const names = (await loadSharedFacts(owner.database, groupId)).filter((fact) => fact.operation.entityId === 'floor').map((fact) => fact.operation.payload.name);
    assert.ok(names.includes('所有者が書いた名前')); assert.ok(names.includes('メンバーが書いた名前'));
  } finally { owner.connection.close(); member.connection.close(); }
});
