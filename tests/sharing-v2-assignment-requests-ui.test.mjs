import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { decisionFixture, range, ref } from './helpers/sharing-v2-decision-fixture.mjs';
import { groupId, receiptsFor, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { listSharingOutbox, loadSharedFacts, applyReceivedSharedFacts } from '../src/platform/storage/sharing-ledger.ts';

async function fixture(secondOwner = false) {
  const f = await decisionFixture({ fixed: true, secondOwner }); const devices = [f.owner, f.member, ...(f.owner2 ? [f.owner2] : [])];
  await f.a.actions.assign(ref, ['member'], 'this', true); await f.deliver(f.owner, devices);
  const [request] = await f.b.actions.requestAssignment(ref, { memberIds: [], start: 'this', scope: 'once', fixed: false }); await f.deliver(f.member, devices);
  return { ...f, devices, assignmentRequest: request };
}
async function ui(f, platform, extra = {}) {
  const props = { model: await f.a.readModel(range), actions: f.a.actions, busy: false,
    run: async (work) => { await work(); props.model = await f.a.readModel(range); }, ...extra };
  const screen = screenHarness('src/features/sharing/v2-ui/assignment-requests.tsx', { exportName: 'V2AssignmentRequests', props, platform });
  return { screen, props, update: async () => { props.model = await f.a.readModel(range); screen.render(); } };
}
for (const platform of ['ios', 'android']) {
  test(`${platform} v2 an explicit assignment rejection preserves the original assignees and records its receipt`, async () => {
    const f = await fixture();
    try {
      const { screen, update } = await ui(f, platform); await screen.press('担当変更を拒否');
      assert.ok(screen.text().includes('回答の送信待ち')); await f.deliver(f.owner); await update(); await screen.press('最新の担当申請を表示');
      assert.ok(screen.text().includes('拒否されました'));
      const model = await f.b.readModel(range); assert.equal(model.assignmentRequests[0].kind, 'rejected');
      assert.deepEqual(model.plan.occurrences.find((round) => round.id === f.assignmentRequest.payload.occurrenceId).assigneeIds, ['member']);
    } finally { f.close(); }
  });
  test(`${platform} v2 a changed assignment answer cannot be overwritten by a stale screen callback`, async () => {
    const f = await fixture(true);
    try {
      const { screen, update } = await ui(f, platform); const approve = screen.button('担当変更を承認');
      await f.c.actions.answerAssignment(f.assignmentRequest.operationId, 'reject'); await f.deliver(f.owner2, f.devices);
      const before = (await listSharingOutbox(f.owner.database, groupId)).length;
      await approve.props.onPress(); await screen.flush(); await update();
      assert.equal((await listSharingOutbox(f.owner.database, groupId)).length, before);
      assert.ok(screen.text().includes('最新の内容を確認')); assert.equal(screen.button('担当変更を承認').props.disabled, true);
    } finally { f.close(); }
  });
  test(`${platform} v2 assignment answer conflicts route into an explicit formal resolution without discarding the old answers`, async () => {
    const f = await fixture(true); const navigation = [];
    try {
      await f.a.actions.answerAssignment(f.assignmentRequest.operationId, 'approve'); await f.c.actions.answerAssignment(f.assignmentRequest.operationId, 'reject');
      await f.deliver(f.owner, f.devices); await f.deliver(f.owner2, f.devices);
      const requests = await ui(f, platform, { onResolve: (id) => navigation.push(id) });
      assert.ok(requests.screen.text().includes('回答が競合')); await requests.screen.press('家事回で担当の競合を解決');
      assert.deepEqual(navigation, [f.assignmentRequest.payload.occurrenceId]);
      const props = { model: await f.a.readModel(range), round: null, actions: f.a.actions, busy: false,
        run: async (work) => { await work(); props.model = await f.a.readModel(range); props.round = props.model.plan.occurrences.find((round) => round.id === f.assignmentRequest.payload.occurrenceId); } };
      props.round = props.model.plan.occurrences.find((round) => round.id === f.assignmentRequest.payload.occurrenceId);
      const form = screenHarness('src/features/sharing/v2-ui/assignment-form.tsx', { exportName: 'V2AssignmentForm', props, platform });
      const check = form.nodes().find((node) => node.type === 'Switch' && node.props.accessibilityLabel === '元の担当・競合と履歴への影響を確認した');
      check.props.onValueChange(true); await form.flush(); await form.press('担当変更を保存');
      await requests.update(); await requests.screen.press('最新の担当申請を表示');
      assert.ok(requests.screen.text().includes('管理者による担当指定で確認済み'));
      assert.throws(() => requests.screen.button('家事回で担当の競合を解決'), /missing button/);
      const state = await f.owner.repository.readState(); assert.equal(state.assessment.view.ofType('assignmentDecision').length, 2);
      assert.equal(state.assessment.assignmentRequests[0].kind, 'conflict');
      assert.deepEqual(props.round.assignmentConflictIds, []);
    } finally { f.close(); }
  });
  test(`${platform} v2 expired assignment requests retain their offline answers without showing an approval control`, async () => {
    const f = await fixture();
    try {
      await f.a.actions.answerAssignment(f.assignmentRequest.operationId, 'approve');
      const [witness] = await f.b.actions.addChore('受付時刻の検査'); const facts = await loadSharedFacts(f.member.database, groupId);
      const receipts = receiptsFor(facts).map((receipt) => receipt.operationId === witness.operationId ? { ...receipt, receivedAtMs: Date.parse('2026-11-02T00:00:00Z') } : receipt);
      await applyReceivedSharedFacts(f.owner.database, groupId, facts, 'expiry', f.owner.repository.project, undefined,
        now().getTime(), f.owner.repository.evidenceForServerReceipts(receipts));
      const { screen, props } = await ui(f, platform); assert.equal(props.model.assignmentRequests[0].kind, 'expired');
      assert.ok(screen.text().includes('期限後に届いた承認で元の申請を自動確定しません'));
      assert.throws(() => screen.button('担当変更を承認'), /missing button/);
      assert.deepEqual(props.model.plan.occurrences.find((round) => round.id === f.assignmentRequest.payload.occurrenceId).assigneeIds, ['member']);
    } finally { f.close(); }
  });
}
