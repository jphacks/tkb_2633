import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture, seeds, now, groupId, receiptsFor } from './helpers/sharing-v2-repository-fixture.mjs';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice } from '../src/features/sharing/roster.ts';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { applyReceivedSharedFacts, listSharingOutbox, loadSharedFacts, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';

const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const ids = field => field.candidates.map(candidate => candidate.operationId);
function controller(d) { let n = 0; return createV2GroupController(d.repository, { makeId: () => `group-policy-${d.options.identity.deviceId}-${++n}`, now, sync: async () => {} }); }
async function receive(d, facts) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
  await applyReceivedSharedFacts(d.database, groupId, facts, String(facts.length), d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
async function setup() {
  const f = await fixture(); const d = await f.device(); const initial = seeds();
  Object.assign(initial[0].payload.configuration, { delegationEnabled: false, allowBeforeWindow: false, completionPushEnabled: true });
  await d.repository.commit(initial); return { f, d, c: controller(d), close: () => d.connection.close() };
}
async function open(c, platform) {
  const effects = []; const cleanups = []; let focus; let backs = 0;
  const props = { model: await c.readModel(range, { groupPolicy: true }), controller: c, onSaved: async () => { props.model = await c.readModel(range, { groupPolicy: true }); }, onBack: () => { backs++; } };
  const screen = screenHarness('src/features/sharing/v2-ui/group-policy-editor.tsx', { exportName: 'V2GroupPolicyEditor', platform, props,
    effect: callback => effects.push(callback), focusEffect: callback => { focus = callback; } });
  const commit = () => { for (const effect of effects.splice(0)) { const cleanup = effect(); if (typeof cleanup === 'function') cleanups.push(cleanup); } };
  const settle = async predicate => { for (let n = 0; n < 35; n++) { commit(); await screen.flush(); if (!predicate || predicate()) return; } assert.fail(screen.text()); };
  const leave = focus?.(); await settle();
  return { props, screen, commit, settle, backs: () => backs, close: async () => {
    if (screen.text().includes('入力を最新のルールに戻す')) await screen.press('入力を最新のルールに戻す');
    leave?.(); for (const cleanup of cleanups) cleanup(); await screen.flush();
  } };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} group kind and rule changes autosave together without resetting customized flags or granting anyone rights`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      const before = await listSharingOutbox(f.d.database, groupId); const original = ui.props.model.groupPolicy.value;
      assert.equal((await f.c.readModel(range)).groupPolicy, undefined);
      await ui.screen.press('日時変更のルールを開く');
      const switchNode = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '担当者の期間後への変更を許可');
      const kind = ui.screen.nodes().find(node => node.props.accessibilityRole === 'radio' && node.props.accessibilityLabel === '同居人');
      kind.props.onPress(); switchNode.props.onValueChange(true); await ui.screen.flush(); await ui.screen.press('戻る');
      await ui.settle(() => ui.backs() === 1);
      const next = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy.value;
      assert.deepEqual(next, { ...original, kind: 'roommates', allowAfterWindow: true });
      assert.equal((await listSharingOutbox(f.d.database, groupId)).length, before.length + 1);
      assert.equal((await f.d.repository.readState()).assessment.view.ofType('datePermission').length, 0);
      assert.deepEqual(ui.props.model.plan.history, []); assert.equal(ui.props.model.configurations[0].configuration.intervalDays, 7);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} group rule edits reject an unseen concurrent change and retain the draft until it is discarded`, async () => {
    const f = await setup(); const ui = await open(f.c, platform);
    try {
      await ui.screen.press('日時変更のルールを開く'); const old = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '前倒しの変更を自動承認');
      await f.c.actions.patchGroupPolicy({ allowSubstitution: false });
      ui.props.model = await f.c.readModel(range, { groupPolicy: true }); ui.screen.render(); ui.commit();
      old.props.onValueChange(false); await ui.screen.press('戻る'); await ui.settle(() => ui.screen.text().includes('別の変更が届いています'));
      assert.equal(ui.backs(), 0); const current = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy.value;
      assert.equal(current.autoApproveEarlier, true); assert.equal(current.allowSubstitution, false);
      await ui.screen.press('入力を最新のルールに戻す'); await ui.settle();
      const restored = ui.screen.nodes().find(node => node.type === 'Switch' && node.props.accessibilityLabel === '前倒しの変更を自動承認'); assert.equal(restored.props.value, true);
    } finally { await ui.close(); f.close(); }
  });

  test(`${platform} group rule conflicts retain authenticated candidates and need an explicit current resolution`, async () => {
    const f = await setup(); const secondIdentity = await createDeviceIdentity(sharingTestCrypto);
    f.f.archive.push(approveSharedDevice(f.f.archive.at(-1), f.f.owner, 'owner', secondIdentity));
    const other = await f.f.device('owner', secondIdentity); let ui;
    try {
      await receive(other, await loadSharedFacts(f.d.database, groupId)); const second = controller(other);
      const source = (await f.c.readModel(range, { groupPolicy: true })).groupPolicy;
      await f.c.actions.editGroupPolicy({ value: { ...source.value, allowBeforeWindow: true }, basisOperationIds: ids(source) });
      await second.actions.editGroupPolicy({ value: { ...source.value, allowSubstitution: false }, basisOperationIds: ids(source) });
      await receive(f.d, await loadSharedFacts(other.database, groupId)); ui = await open(f.c, platform);
      const conflict = ui.props.model.groupPolicy; assert.equal(conflict.kind, 'conflict'); assert.equal(ui.props.model.plan.policy, null);
      assert.throws(() => ui.screen.button('ルール候補1で解決する'), /missing button/u);
      const candidate = ui.screen.nodes().find(node => node.props.accessibilityRole === 'button' && node.props.accessibilityLabel?.startsWith('ルール候補1 · '));
      await candidate.props.onPress(); await ui.screen.flush(); await ui.screen.press('ルール候補1で解決する');
      await ui.settle(() => ui.props.model.groupPolicy.kind === 'value');
      assert.deepEqual(ui.props.model.groupPolicy.value, conflict.candidates[0].value);
      await receive(other, await loadSharedFacts(f.d.database, groupId)); await receive(f.d, await loadSharedFacts(other.database, groupId));
      assert.equal((await second.readModel(range)).plan.planHash, (await f.c.readModel(range)).plan.planHash);
    } finally { await ui?.close(); other.connection.close(); f.close(); }
  });

  test(`${platform} ordinary members can read group rules but cannot mutate them through UI or the command API`, async () => {
    const f = await setup(); const member = await f.f.device('member', f.f.member); let ui;
    try {
      await receive(member, await loadSharedFacts(f.d.database, groupId)); const c = controller(member); ui = await open(c, platform);
      assert.match(ui.screen.text(), /管理者が変更/u); assert.equal(ui.screen.nodes().some(node => node.type === 'Switch' || node.props.accessibilityRole === 'radio'), false);
      const before = await listSharingOutbox(member.database, groupId); const source = ui.props.model.groupPolicy;
      await assert.rejects(c.actions.editGroupPolicy({ value: { ...source.value, allowBeforeWindow: true }, basisOperationIds: ids(source) }), { code: 'sharing/v2-authority-denied' });
      assert.deepEqual(await listSharingOutbox(member.database, groupId), before);
      await ui.screen.press('戻る'); assert.equal(ui.backs(), 1);
    } finally { await ui?.close(); member.connection.close(); f.close(); }
  });
}
