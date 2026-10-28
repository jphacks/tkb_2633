import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2FieldEditorState } from '../src/features/sharing/v2-ui/field-editor-state.ts';
import { listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const codecs = {
  name: { format: (value) => value ?? '', parse: (text) => { if (!text.trim()) throw new Error('名前を入力してください。'); return text.trim(); } },
  instructions: { format: (value) => (value ?? []).join('\n'), parse: (text) => text.split('\n').map((line) => line.trim()).filter(Boolean) },
};
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); let id = 0;
  const c = createV2GroupController(d.repository, { makeId: () => `text-save-${++id}`, now, sync: async () => {} });
  const fields = async () => { const row = (await c.readModel(range, { detailChoreId: 'floor' })).choreDetails.find((entry) => entry.choreId === 'floor');
    return { name: row.fields.name, instructions: row.fields.instructions }; };
  return { ...d, c, fields };
}
const basis = (field) => field.candidates.map((candidate) => candidate.operationId);

test('v2 field autosave preserves raw newlines and advances its own causal base when typing continues during a save', async () => {
  const d = await setup();
  try {
    const entered = deferred(); const release = deferred(); let first = true; let store;
    const options = { fields: await d.fields(), codecs, delayMs: 60000, onSaved: async () => store.updateInput({ ...options, fields: await d.fields() }),
      save: async (edits) => { if (first) { first = false; entered.resolve(); await release.promise; } return d.c.actions.patchChoreDetails('floor', edits); } };
    store = createV2FieldEditorState(options); store.change('instructions', '手順1\n'); const running = store.flush(); await entered.promise;
    store.change('instructions', '手順1\n手順2\n'); release.resolve(); assert.equal(await running, true);
    assert.deepEqual((await d.fields()).instructions.value, ['手順1', '手順2']);
    assert.equal(store.getSnapshot().raw.instructions, '手順1\n手順2\n'); assert.equal(store.hasDraft(), false);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});

test('v2 field autosave keeps a queued field base after another field saved and refuses a concurrent remote overwrite', async () => {
  const d = await setup();
  try {
    const entered = deferred(); const release = deferred(); let first = true; let store;
    const options = { fields: await d.fields(), codecs, delayMs: 60000, onSaved: async () => store.updateInput({ ...options, fields: await d.fields() }),
      save: async (edits) => { if (first) { first = false; entered.resolve(); await release.promise; } return d.c.actions.patchChoreDetails('floor', edits); } };
    store = createV2FieldEditorState(options); store.change('name', '自分の名前変更'); const running = store.flush(); await entered.promise;
    store.change('instructions', '自分が入力中の手順');
    await d.c.actions.patchChoreDetails('floor', [{ field: 'instructions', value: ['別端末の変更'], basisOperationIds: [] }]);
    release.resolve(); assert.equal(await running, false);
    assert.equal((await d.fields()).name.value, '自分の名前変更'); assert.deepEqual((await d.fields()).instructions.value, ['別端末の変更']);
    assert.equal(store.getSnapshot().raw.instructions, '自分が入力中の手順'); assert.equal(store.hasDraft(), true);
    store.discard('instructions'); assert.equal(store.getSnapshot().raw.instructions, '別端末の変更'); assert.equal(await store.flush(), true);
  } finally { d.connection.close(); }
});

test('v2 field autosave ignores older refreshes and does not replay durable edits after a view refresh fails', async () => {
  const d = await setup();
  try {
    const old = await d.fields();
    const options = { fields: old, codecs, delayMs: 60000, save: (edits) => d.c.actions.patchChoreDetails('floor', edits), onSaved: async () => { throw new Error('view failed'); } };
    const store = createV2FieldEditorState(options); store.change('name', '保存した名前'); assert.equal(await store.flush(), true);
    assert.match(store.getSnapshot().refreshError, /保存済み/u); assert.equal(store.getSnapshot().status.phase, 'saved');
    store.updateInput({ ...options, fields: old }); assert.equal(store.getSnapshot().raw.name, '保存した名前');
    const before = await listSharingOutbox(d.database, groupId); assert.equal(await store.flush(), true); assert.deepEqual(await listSharingOutbox(d.database, groupId), before);
    store.change('name', '次に保存する名前'); assert.equal(await store.flush(), true);
    assert.equal((await d.fields()).name.value, '次に保存する名前');
  } finally { d.connection.close(); }
});

test('v2 field autosave uses the acknowledged current source even when the requested value was already saved by another view', async () => {
  const d = await setup();
  try {
    const old = await d.fields(); const options = { fields: old, codecs, delayMs: 60000,
      save: (edits) => d.c.actions.patchChoreDetails('floor', edits), onSaved: async () => {} };
    const store = createV2FieldEditorState(options);
    await d.c.actions.patchChoreDetails('floor', [{ field: 'name', value: '一致した名前', basisOperationIds: basis(old.name) }]);
    store.change('name', '一致した名前'); assert.equal(await store.flush(), true);
    store.change('name', '続けて編集'); assert.equal(await store.flush(), true); assert.equal((await d.fields()).name.value, '続けて編集');
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 6);
  } finally { d.connection.close(); }
});

test('v2 field input binds the value actually rendered when a remote store update arrives before the next paint', async () => {
  const d = await setup();
  try {
    const displayed = await d.fields(); const options = { fields: displayed, codecs, delayMs: 60000,
      save: (edits) => d.c.actions.patchChoreDetails('floor', edits), onSaved: async () => {} };
    const store = createV2FieldEditorState(options);
    await d.c.actions.patchChoreDetails('floor', [{ field: 'name', value: 'まだ画面には描画されていない変更', basisOperationIds: basis(displayed.name) }]);
    store.updateInput({ ...options, fields: await d.fields() });
    store.change('name', '古い画面で入力した名前', displayed.name);
    assert.equal(await store.flush(), false); assert.equal((await d.fields()).name.value, 'まだ画面には描画されていない変更');
    assert.equal(store.getSnapshot().raw.name, '古い画面で入力した名前');
    store.discard(); const rendered = store.getSnapshot().fields.name; store.change('name', '確認後の入力', rendered); assert.equal(await store.flush(), true);
    // Its own acknowledged write may complete before React paints its next source ID; continued typing still uses that acknowledgement.
    store.change('name', '確認後の入力を続ける', rendered); assert.equal(await store.flush(), true);
    assert.equal((await d.fields()).name.value, '確認後の入力を続ける');
    const oldSteps = store.getSnapshot().fields.instructions; const oldRaw = store.getSnapshot().raw.instructions;
    await d.c.actions.patchChoreDetails('floor', [{ field: 'instructions', value: ['別端末の手順'], basisOperationIds: [] }]);
    store.updateInput({ ...options, fields: await d.fields() });
    store.changeWith('instructions', (raw) => raw + '表示していた手順', oldSteps, oldRaw);
    assert.equal(store.getSnapshot().raw.instructions, '表示していた手順'); assert.equal(await store.flush(), false);
    assert.deepEqual((await d.fields()).instructions.value, ['別端末の手順']); store.discard();
    const currentSteps = store.getSnapshot().fields.instructions; const currentRaw = store.getSnapshot().raw.instructions;
    store.changeWith('instructions', (raw) => raw + '1', currentSteps, currentRaw);
    store.changeWith('instructions', (raw) => raw + '2', currentSteps, currentRaw);
    assert.equal(await store.flush(), true); assert.deepEqual((await d.fields()).instructions.value, ['別端末の手順12']);
  } finally { d.connection.close(); }
});

test('v2 field autosave keeps invalid input out of SQLite and prevents leaving until correction or explicit discard', async () => {
  const d = await setup();
  try {
    const options = { fields: await d.fields(), codecs, delayMs: 60000,
      save: (edits) => d.c.actions.patchChoreDetails('floor', edits), onSaved: async () => {} };
    const store = createV2FieldEditorState(options); let left = 0;
    store.change('name', 'valid'); store.change('name', ' '); assert.equal(await store.flush(), false);
    assert.equal(await store.navigateAfterSave(() => { left++; }), false); assert.equal(left, 0);
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 4);
    assert.equal(store.getSnapshot().raw.name, ' '); store.discard('name'); assert.equal(store.hasDraft(), false);
    assert.equal(await store.navigateAfterSave(() => { left++; }), true); assert.equal(left, 1);
    assert.equal(await store.navigateAfterSave(() => { left++; }), false); assert.equal(left, 1);
  } finally { d.connection.close(); }
});
