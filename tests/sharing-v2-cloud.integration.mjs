import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, encryptSharedOperation, signSharedOperation, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, upgradeSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { v2AuthorProofDigest, bindV2ServerReceipt } from '../src/features/sharing/v2/server-receipts.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { createDatabase } from './helpers/sqlite.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { createV2Synchronizer } from '../src/features/sharing/v2/synchronizer.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { addDays as addLocalDays } from '../src/domain/scheduling/local-date.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { createSharedGroupManager } from '../src/features/sharing/group-manager.ts';
import { createV2WorkspaceSession } from '../src/features/sharing/v2/workspace-session.ts';
import { readCloudWorkspaceArchive } from '../src/features/sharing/workspace-protocol.ts';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { createSharedJoinRequest } from '../src/features/sharing/invitations.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run v2 cloud tests only against the local emulator.');
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const groupId = 'v2-cloud-group';
async function fixture(schemaVersion = 2) {
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const store = environment.authenticatedContext('owner').firestore(); let active = 'owner';
  const cloud = createSharingCloud(store, 'owner', () => active);
  const roster = createSharedRoster(groupId, 'owner', identity, { schemaVersion });
  const wrapped = await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner');
  await cloud.createGroup(roster, wrapped);
  const make = async (sequence, patch = {}) => {
    const operation = { schemaVersion: 2, receiptContext: {}, recordedAt: '2030-01-01T00:00:00Z', groupId, operationId: `operation-${sequence}`,
      authorUserId: 'owner', authorDeviceId: identity.deviceId, keyVersion: 1, deviceSequence: sequence, logicalClock: sequence,
      context: sequence > 1 ? { [identity.deviceId]: sequence - 1 } : {}, entityType: 'chore', entityId: 'floor', operationType: 'patch',
      payload: { name: `秘密のv2家事 ${sequence}` }, ...patch };
    const fact = signSharedOperation(operation, identity);
    return { fact, envelope: await encryptSharedOperation(crypto, operation, key, identity), authorProofDigest: v2AuthorProofDigest(fact) };
  };
  return { identity, key, roster, store, cloud, make, root: doc(store, 'sharingGroups', groupId), switchAccount: () => { active = 'another'; } };
}

test('v2 workspace sessions restore real encrypted bootstrap and offline edits across approved user devices without private planner adapters', async () => {
  const f = await fixture(); const ownerDb = createDatabase(); const memberDb = createDatabase();
  const memberIdentity = await createDeviceIdentity(crypto); const now = new Date(); const anchorDate = sharedLocalDate(now, 'Asia/Tokyo');
  let ownerArchive = [f.roster]; let memberArchive; let ownerActive = true; let ordinal = 0;
  let ownerRecord = { userId: 'owner', groupId, status: 'creating', displayName: 'セッション検査', anchor: f.roster, rosterArchive: ownerArchive,
    creation: { wrappedKey: {}, timeZone: 'Asia/Tokyo', anchorDate, ownerDisplayName: '所有者' } };
  const ownerKeys = new Map([[1, f.key]]); const memberKeys = new Map();
  function dependencies(h, userId, identity, cloud, keys, readRecord, saveArchive, archive) {
    return { database: h.database, householdId: 'v2-session-only', userId, groupId, identity, cloud, crypto, readRecord, saveArchive, archive,
      readKey: async (version) => keys.get(version)?.slice() ?? null, saveKey: async (version, value) => { keys.set(version, value.slice()); },
      serialized: async (work) => work(), changed: () => {}, assertCurrentAccount: () => { if (userId === 'owner' && !ownerActive) throw new Error('account changed'); },
      assertWritable: () => {}, makeId: () => `session-${userId}-${++ordinal}`, markLeft: async () => {} };
  }
  const ownerDeps = dependencies(ownerDb, 'owner', f.identity, f.cloud, ownerKeys, async () => ({ ...ownerRecord, rosterArchive: ownerArchive }),
    async (value) => { ownerArchive = value; }, () => ownerArchive);
  try {
    const owner = await createV2WorkspaceSession({ ...ownerDeps, creationKind: 'roommates' }); await owner.synchronizer.sync({ force: true });
    assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, 23);
    ownerRecord = { ...ownerRecord, status: 'active' };
    const invite = await owner.manager.createInvitation(); const request = createSharedJoinRequest(invite, 'member', memberIdentity, Date.now());
    const memberCloud = createSharingCloud(environment.authenticatedContext('member').firestore(), 'member', () => 'member');
    await memberCloud.submitJoinRequest(invite.invitation, request); await owner.manager.approve(invite.invitation, request);
    const joining = { userId: 'member', groupId, status: 'joining', anchor: invite.invitation.body.pin, rosterArchive: [], join: { invitation: invite.invitation, request } };
    memberArchive = await readCloudWorkspaceArchive(joining, (await memberCloud.readGroup(groupId)).roster, memberCloud.readRoster);
    const memberDeps = dependencies(memberDb, 'member', memberIdentity, memberCloud, memberKeys, async () => ({ ...joining, rosterArchive: memberArchive }),
      async (value) => { memberArchive = value; }, () => memberArchive);
    const member = await createV2WorkspaceSession(memberDeps); await member.synchronizer.sync({ force: true });
    const range = { from: anchorDate, through: addLocalDays(anchorDate, 14), asOfDate: anchorDate };
    const initial = await member.controller.readModel(range); assert.equal(initial.plan.policy.kind, 'roommates');
    assert.equal(initial.plan.chores.length, 20); assert.equal(initial.plan.occurrences.length, 0);
    const chore = initial.plan.chores[0];
    await member.repository.commit([{ operationId: 'session-offline-edit', entityType: 'chore', entityId: chore.id, operationType: 'patch', payload: { name: '再起動後も残る変更' } }]);
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 1);
    const restart = await createV2WorkspaceSession(memberDeps);
    assert.equal((await restart.controller.readModel(range)).plan.chores.find((item) => item.id === chore.id).name, '再起動後も残る変更');
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.deepEqual((await owner.controller.readModel(range)).plan, (await restart.controller.readModel(range)).plan);
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0);
    const field = async (session) => (await session.controller.readModel(range, { detailChoreId: chore.id })).choreDetails[0].fields.name;
    const ownerBase = await field(owner); const memberBase = await field(restart);
    await owner.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '所有者のオフライン編集', basisOperationIds: ownerBase.candidates.map((source) => source.operationId) }]);
    await restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: 'メンバーのオフライン編集', basisOperationIds: memberBase.candidates.map((source) => source.operationId) }]);
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    const conflict = await field(restart); assert.equal(conflict.kind, 'conflict'); assert.equal(conflict.candidates.length, 2);
    assert.deepEqual(await field(owner), conflict);
    const observed = conflict.candidates.map((source) => source.operationId); const beforeResolution = (await f.cloud.readGroup(groupId)).group.headSequence;
    await assert.rejects(restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '黙った上書き', basisOperationIds: observed }]), { code: 'sharing/v2-stale-settings' });
    assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, beforeResolution);
    await restart.controller.actions.patchChoreDetails(chore.id, [{ field: 'name', value: '両方を確認した名前', basisOperationIds: observed, resolveOperationIds: observed }]);
    await restart.synchronizer.sync({ force: true }); await owner.synchronizer.sync({ force: true });
    assert.equal((await field(owner)).value, '両方を確認した名前'); assert.deepEqual(await field(owner), await field(restart));
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0);
    const policy = (await owner.controller.readModel(range, { groupPolicy: true })).groupPolicy;
    const basisOperationIds = policy.candidates.map(source => source.operationId);
    const headBeforePolicy = (await f.cloud.readGroup(groupId)).group.headSequence;
    await assert.rejects(restart.controller.actions.editGroupPolicy({ value: { ...policy.value, delegationEnabled: true }, basisOperationIds }), { code: 'sharing/v2-authority-denied' });
    assert.equal((await listSharingOutbox(memberDb.database, groupId)).length, 0); assert.equal((await f.cloud.readGroup(groupId)).group.headSequence, headBeforePolicy);
    const updatedPolicy = { ...policy.value, kind: 'family', delegationEnabled: true };
    await owner.controller.actions.editGroupPolicy({ value: updatedPolicy, basisOperationIds });
    await owner.synchronizer.sync({ force: true }); await restart.synchronizer.sync({ force: true });
    for (const session of [owner, restart]) {
      const model = await session.controller.readModel(range, { groupPolicy: true });
      assert.deepEqual(model.groupPolicy.value, updatedPolicy); assert.deepEqual(model.plan.policy, updatedPolicy);
      assert.equal((await session.repository.readState()).assessment.view.ofType('datePermission').length, 0);
    }
    ownerActive = false; await assert.rejects(owner.synchronizer.sync({ force: true }), /account changed/u);
    assert.equal(ownerDb.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(memberDb.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { ownerDb.connection.close(); memberDb.connection.close(); }
});

test('normal v2 workspace creation uses the real gateway and Rules and a no-change sync cannot enqueue another local edit', async () => {
  const f = await fixture(); const h = await workspaceHarness({ cloud: f.cloud, deferWorkspaceTimers: true });
  try {
    const workspace = await h.api.createV2SharingWorkspace('新しい家族', 'family', 'Asia/Tokyo');
    const result = await workspace.sync({ force: true, budgetMs: 120_000 }); assert.equal(result.complete, true); assert.equal(result.pending, 0);
    const record = await workspace.record(); assert.equal(record.status, 'active'); assert.ok(record.lastSuccessfulSyncAt); assert.equal(record.lastErrorCode, null);
    assert.equal((await f.cloud.readGroup(workspace.groupId)).group.headSequence, 23); assert.equal((await workspace.checkpoint()).pendingCount, 0);
    const state = await workspace.session.repository.readState(); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1));
    assert.equal(state.assessment.view.field('groupPolicy', 'policy', 'configuration', at).value.kind, 'family');
    assert.equal((await workspace.readOverview()).chores.length, 20);
    await workspace.sync({ force: true }); assert.equal((await f.cloud.readGroup(workspace.groupId)).group.headSequence, 23);
    await h.api.saveSharingSelection(record); assert.deepEqual(JSON.parse(h.vault.get('active-workspace')), { groupId: workspace.groupId, userId: 'owner' });
    h.auth.uid = 'another-user'; await assert.rejects(workspace.session.controller.actions.addChore('拒否される追加'));
    assert.equal((await workspace.checkpoint()).pendingCount, 0);
  } finally { await h.close(); }
});

test('v2 cloud commits immutable server receipts with encrypted events, bounds receipt recovery and keeps the same original timestamp on retry', async () => {
  const f = await fixture(); const facts = []; let first;
  for (let sequence = 1; sequence <= 205; sequence++) {
    const item = await f.make(sequence); facts.push(item.fact);
    const sent = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
    assert.equal(sent.serverReceipt.uploadSequence, sequence); assert.equal(sent.serverReceipt.receivedKeyVersion, 1);
    bindV2ServerReceipt(sent.serverReceipt, item.fact, [f.roster]);
    assert.ok(Math.abs(sent.serverReceipt.receivedAtMs - Date.now()) < 60_000);
    if (sequence === 1) {
      first = sent; const retry = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
      assert.deepEqual(retry.serverReceipt, sent.serverReceipt);
    }
  }
  const recovered = await f.cloud.readReceipts(groupId, facts.map((fact) => fact.operation.operationId));
  assert.deepEqual(await f.cloud.readReceipts(groupId, facts.map((fact) => fact.operation.operationId), { deadlineAtMs: Date.now() - 1 }), []);
  assert.equal(recovered.length, 205); assert.deepEqual(recovered.find((receipt) => receipt.operationId === 'operation-1'), first.serverReceipt);
  const page = await f.cloud.pull(groupId, 0); const second = await f.cloud.pull(groupId, 100); const third = await f.cloud.pull(groupId, 200);
  assert.deepEqual([page.events.length, second.events.length, third.events.length], [100, 100, 5]);
  assert.deepEqual(page.events[0].serverReceipt, first.serverReceipt);
  const raw = (await getDocFromServer(doc(f.root, 'receipts', 'operation-1'))).data();
  assert.deepEqual(Object.keys(raw).sort(), ['authorDeviceId', 'authorProofDigest', 'authorUserId', 'createdAt', 'keyVersion', 'schemaVersion', 'uploadSequence']);
  assert.equal(JSON.stringify(raw).includes('秘密'), false); assert.equal(JSON.stringify(raw).includes('authorSignature'), false);
  await assert.rejects(f.cloud.readReceipts(groupId, Array.from({ length: 1001 }, (_, index) => `id-${index}`)));
  f.switchAccount(); await assert.rejects(f.cloud.readReceipts(groupId, ['operation-1']), /切り替わり/);
});
test('v2 Rules deny forged receipt clocks, missing or mismatched paired receipts, other accounts and receipt rewrites or removal', async () => {
  const f = await fixture();
  async function forged({ omitReceipt = false, eventChange = {}, receiptChange = {}, updateRoot = true } = {}) {
    const event = { schemaVersion: 2, authorUserId: 'owner', authorDeviceId: f.identity.deviceId, keyVersion: 1,
      uploadSequence: 1, envelopeJson: 'ciphertext-only', authorProofDigest: 'a'.repeat(64), createdAt: serverTimestamp(), ...eventChange };
    const { envelopeJson: _encrypted, ...receipt } = event;
    const batch = writeBatch(f.store); batch.set(doc(f.root, 'events', 'forged'), event);
    if (!omitReceipt) batch.set(doc(f.root, 'receipts', 'forged'), { ...receipt, ...receiptChange });
    if (updateRoot) batch.update(f.root, { headSequence: 1, lastOperationId: 'forged', updatedAt: serverTimestamp() });
    return batch.commit();
  }
  await assertFails(forged({ omitReceipt: true }));
  await assertFails(forged({ eventChange: { createdAt: Timestamp.fromMillis(1000) }, receiptChange: { createdAt: Timestamp.fromMillis(1000) } }));
  await assertFails(forged({ receiptChange: { authorProofDigest: 'b'.repeat(64) } }));
  await assertFails(forged({ updateRoot: false }));
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 0);
  const item = await f.make(1); await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const ref = doc(f.root, 'receipts', item.fact.operation.operationId);
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp() })); await assertFails(deleteDoc(ref));
  await assertFails(getDocFromServer(doc(environment.authenticatedContext('outsider').firestore(), 'sharingGroups', groupId, 'receipts', 'operation-1')));
  await assertFails(setDoc(doc(f.root, 'receipts', 'unpaired'), { ...(await getDocFromServer(ref)).data(), createdAt: serverTimestamp() }));
});
test('v2 compacted events retain their original server receipt and retry requests a verified snapshot rather than recreating an acceptance time', async () => {
  const f = await fixture(); const item = await f.make(1); const accepted = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const replica = buildSharedReplica(groupId, [item.fact.operation]);
  const snapshot = await createEncryptedSharedSnapshot(crypto, replica, [item.fact], f.roster, f.identity, f.key, 'v2-compact', 1,
    (uid, device, version) => sharedAuthorIdentity(f.roster, uid, device, version));
  await f.cloud.prepareSnapshot(snapshot, f.roster); await f.cloud.publishSnapshot(snapshot.manifest, f.roster);
  await deleteDoc(doc(f.root, 'events', 'operation-1'));
  await assert.rejects(f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest }), { code: 'sharing/snapshot-required' });
  assert.deepEqual((await f.cloud.readReceipts(groupId, ['operation-1']))[0], accepted.serverReceipt);
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 1);
});
test('v2 Rules require an explicit owner-preserving protocol upgrade snapshot and prevent downgrade', async () => {
  const f = await fixture(1); const next = upgradeSharedRoster(f.roster, f.identity);
  const fields = (await import('../src/features/sharing/cloud-contract.ts')).rosterCloudFields(next);
  const snapshotId = 'upgrade-snapshot';
  const mutate = async (extra = {}, includeSnapshot = false) => {
    const batch = writeBatch(f.store);
    batch.update(f.root, { ...fields, snapshotId, snapshotThroughSequence: 0, updatedAt: serverTimestamp(), ...extra });
    batch.set(doc(f.root, 'rosters', '2'), { rosterJson: fields.rosterJson, createdAt: serverTimestamp() });
    if (includeSnapshot) batch.set(doc(f.root, 'snapshots', snapshotId), { keyVersion: 2, throughSequence: 0, manifestJson: 'signed-encrypted-v2-manifest', createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertFails(mutate());
  await assertFails(mutate({ ownerUserId: 'outsider', memberIds: ['outsider'], deviceOwners: { [f.identity.deviceId]: 'outsider' } }, true));
  await mutate({}, true);
  const batch = writeBatch(f.store); batch.update(f.root, { schemaVersion: 1, keyVersion: 3, rosterRevision: 3, rosterJson: 'downgrade', updatedAt: serverTimestamp() });
  batch.set(doc(f.root, 'rosters', '3'), { rosterJson: 'downgrade', createdAt: serverTimestamp() });
  await assertFails(batch.commit());
});
test('v2 real gateway and Rules synchronize isolated SQLite users through key rotation, snapshot, edit, completion and targeted undo', async () => {
  const f = await fixture(); const memberIdentity = await createDeviceIdentity(crypto); let key2;
  function device(userId, identity, cloud, keys) {
    const h = createDatabase(); let archive = [f.roster];
    const repository = createV2EventRepository(h.database, { groupId, userId, householdId: 'local', identity, anchor: f.roster,
      archive: () => archive, assertWritable: () => {} });
    const dependencies = { database: h.database, groupId, userId, identity, crypto, cloud,
      readRecord: async () => ({ groupId, userId, status: 'active', anchor: f.roster, rosterArchive: archive }),
      saveArchive: async (value) => { archive = value; }, readKey: async (version) => keys.get(version)?.slice(),
      saveKey: async (version, bytes) => { keys.set(version, bytes.slice()); }, serialized: async (work) => work(),
      changed: () => {}, assertCurrentAccount: () => {} };
    const sync = createV2Synchronizer({ ...dependencies, repository }); let managerId = 0;
    const manager = createSharedGroupManager({ ...dependencies, project: repository.project, sync: sync.sync, verifyMembership: sync.verifyMembership,
      makeId: () => `v2-manager-${userId}-${++managerId}`, markLeft: async () => {} });
    return { ...h, repository, sync, keys, manager };
  }
  const owner = device('owner', f.identity, f.cloud, new Map([[1, f.key]]));
  const memberCloud = createSharingCloud(environment.authenticatedContext('member').firestore(), 'member', () => 'member');
  const member = device('member', memberIdentity, memberCloud, new Map());
  let restored;
  try {
    await initializeV2EventStore(owner.database, { groupId, userId: 'owner', householdId: 'local' });
    const change = (operationId, entityType, entityId, payload, operationType = 'patch') => ({ operationId, entityType, entityId, payload, operationType });
    await owner.repository.commit([
      change('policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') }),
      change('settings', 'settings', 'settings', { timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
      change('chore', 'chore', 'floor', { name: '床掃除', enabled: true }),
      change('configuration', 'chorePolicy', 'floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27',
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    await owner.sync.sync({ force: true });
    const invitation = await owner.manager.createInvitation();
    const request = createSharedJoinRequest(invitation, 'member', memberIdentity, Date.now());
    await memberCloud.submitJoinRequest(invitation.invitation, request); await owner.manager.approve(invitation.invitation, request);
    const next = (await f.cloud.readGroup(groupId)).roster; key2 = owner.keys.get(2); assert.ok(key2);
    assert.equal(next.body.schemaVersion, 2); assert.equal(next.body.keyVersion, 2);
    assert.equal((await f.cloud.readInvitation(invitation.invitation.body.inviteId)).status, 'used');
    await initializeV2EventStore(member.database, { groupId, userId: 'member', householdId: 'local' });
    await member.sync.sync({ force: true });
    const occurrenceId = v2OccurrenceId(groupId, 'floor', '2026-10-27');
    await member.repository.commit([change('member-edit', 'chore', 'floor', { name: '床を拭く', instructions: ['道具を用意する'] }),
      change('member-work', 'completion', occurrenceId, { choreId: 'floor', anchorDate: '2026-10-27',
        completedAt: new Date(Date.now() - 60_000).toISOString(), completedByMemberId: 'member', subjectUserId: null,
        originalAssigneeIds: [], ruleVersion: 1, outcome: 'completed' }, 'complete')]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    const hash = (device) => device.connection.prepare('SELECT fact_hash FROM sharing_v2_projection').get().fact_hash;
    assert.equal(hash(owner), hash(member)); assert.equal((await loadSharedReplica(owner.database, groupId)).completions.length, 1);
    await member.repository.commit([change('member-undo', 'completion', occurrenceId, { targetOperationId: 'member-work' }, 'undo')]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(hash(owner), hash(member)); assert.equal((await loadSharedReplica(owner.database, groupId)).completions.length, 0);
    for (const d of [owner, member]) {
      assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
      assert.deepEqual(JSON.parse(d.connection.prepare('SELECT rejected_json FROM sharing_v2_projection').get().rejected_json), []);
      assert.equal(d.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    }
    const anchorDate = sharedLocalDate(new Date(Date.now() + 7 * 86400000), 'Asia/Tokyo');
    const requestOccurrence = v2OccurrenceId(groupId, 'approval-floor', anchorDate);
    const day = (date) => ({ precision: 'date', date });
    await owner.repository.commit([
      change('approval-chore', 'chore', 'approval-floor', { name: '承認検査用の家事', enabled: true }),
      change('approval-policy', 'chorePolicy', 'approval-floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const requests = (d) => JSON.parse(d.connection.prepare('SELECT request_states_json FROM sharing_v2_projection').get().request_states_json);
    await member.repository.commit([change('date-request', 'changeRequest', 'date-request', {
      requesterUserId: 'member', choreId: 'approval-floor', anchorDate, occurrenceId: requestOccurrence, subjectUserId: null,
      originalDesignationId: null, original: day(anchorDate), proposed: day(addLocalDays(anchorDate, 3)), proposedMode: 'day',
      proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
      selector: { scope: 'once', occurrenceId: requestOccurrence, anchorDate }, extensionScope: 'once',
    })]);
    assert.equal(requests(member)[0].kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(requests(owner)[0].kind, 'awaiting'); assert.deepEqual(requests(owner), requests(member));
    await owner.repository.commit([change('date-counteroffer', 'requestDecision', 'date-counteroffer', {
      requestId: 'date-request', decision: 'counteroffer', target: day(addLocalDays(anchorDate, 4)), referenceDecisionId: null, allowDuringCooldown: true,
    })]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal(requests(member)[0].kind, 'counteroffered'); assert.deepEqual(requests(member)[0].formal, day(anchorDate));
    assert.equal(requests(member)[0].counteroffers[0].options.allowDuringCooldown, true);
    await member.repository.commit([change('date-consent', 'requestDecision', 'date-consent', {
      requestId: 'date-request', decision: 'acceptCounteroffer', target: null, referenceDecisionId: 'date-counteroffer',
    })]);
    assert.equal(requests(member)[0].kind, 'counteroffered');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    assert.equal(requests(owner)[0].kind, 'approved'); assert.deepEqual(requests(owner)[0].formal, day(addLocalDays(anchorDate, 4)));
    assert.equal(requests(owner)[0].formalOptions.allowDuringCooldown, true);
    assert.deepEqual(requests(owner), requests(member)); assert.equal(hash(owner), hash(member));
    let actionId = 0; const actionOptions = { makeId: () => `assignment-action-${++actionId}`, now: () => new Date() };
    const ownerActions = createV2PlannerActions(owner.repository, actionOptions); const memberActions = createV2PlannerActions(member.repository, actionOptions);
    const assignmentRef = { choreId: 'approval-floor', anchorDate, ruleVersion: 1, subjectUserId: null };
    await ownerActions.assign(assignmentRef, ['member'], 'this', true); await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const [assignmentRequest] = await memberActions.requestAssignment(assignmentRef, { memberIds: [], start: 'this', scope: 'once', fixed: false });
    assert.equal((await member.repository.readState()).assessment.assignmentRequests[0].kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    await ownerActions.answerAssignment(assignmentRequest.operationId, 'approve');
    assert.equal((await owner.repository.readState()).assessment.assignmentRequests[0].kind, 'awaiting');
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await owner.repository.readState()).assessment.assignmentRequests[0].kind, 'approved'); assert.equal(hash(owner), hash(member));
    await ownerActions.remapAssignments([assignmentRequest.operationId], { ...assignmentRef, anchorDate: addLocalDays(anchorDate, 7) }, ['owner'], 'once', false);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await member.repository.readState()).assessment.assignmentRequests[0].cancelled, true); assert.equal(hash(owner), hash(member));
    await owner.repository.commit([
      change('future-assignment-chore', 'chore', 'future-assignment', { name: '次回担当の検査', enabled: true }),
      change('future-assignment-cfg', 'chorePolicy', 'future-assignment', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const nextAnchor = addLocalDays(anchorDate, 2);
    await ownerActions.patchChoreConfiguration('future-assignment', 1, { intervalDays: 3, anchorDate: nextAnchor }, nextAnchor);
    const [futureAssignment] = await ownerActions.assign({ ...assignmentRef, choreId: 'future-assignment' }, ['member'], 'next', true);
    assert.equal(futureAssignment.payload.fromAnchorDate, nextAnchor); assert.equal(futureAssignment.payload.ruleVersion, 2);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    await owner.repository.commit([
      change('calendar-history-chore', 'chore', 'calendar-history', { name: '移動した実施履歴の検査', enabled: true }),
      change('calendar-history-cfg', 'chorePolicy', 'calendar-history', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 30, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const historyRef = { ...assignmentRef, choreId: 'calendar-history' }; const recordedDate = addLocalDays(anchorDate, 90);
    const [oldDate] = await ownerActions.changeDate(historyRef, { mode: 'day', target: day(recordedDate) });
    const [historicalWork] = await ownerActions.complete(historyRef); await ownerActions.cancelDates(historyRef, [oldDate.operationId]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    const historicalRound = async (repository) => buildV2CommonPlan(await repository.readState(), { from: recordedDate, through: recordedDate, asOfDate: anchorDate })
      .occurrences.find((entry) => entry.choreId === 'calendar-history' && entry.anchorDate === anchorDate);
    for (const d of [owner, member]) { const round = await historicalRound(d.repository); assert.ok(round); assert.equal(round.subjects[0].suggestedDate, recordedDate);
      assert.deepEqual(round.subjects[0].completionOperationIds, [historicalWork.operationId]); }
    await owner.repository.commit([
      change('partial-cancel-chore', 'chore', 'partial-cancel', { name: '期間解除の検査', enabled: true }),
      change('partial-cancel-cfg', 'chorePolicy', 'partial-cancel', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate,
        intervalDays: 1, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const partialRef = { ...assignmentRef, choreId: 'partial-cancel' };
    const [repeating] = await ownerActions.changeDate(partialRef, { mode: 'day', target: day(addLocalDays(anchorDate, 1)), selector: { scope: 'ongoing', from: anchorDate } });
    await ownerActions.cancelDates({ ...partialRef, anchorDate: addLocalDays(anchorDate, 2) }, [repeating.operationId], {
      selector: { scope: 'period', range: { from: addLocalDays(anchorDate, 2), through: addLocalDays(anchorDate, 4) } }, expectedRuleIds: [repeating.operationId],
    });
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); assert.equal(hash(owner), hash(member));
    const cancellationPlan = async (repository) => buildV2CommonPlan(await repository.readState(), { from: anchorDate, through: addLocalDays(anchorDate, 7), asOfDate: anchorDate })
      .occurrences.filter((round) => round.choreId === 'partial-cancel');
    const expectedCancellation = await cancellationPlan(owner.repository); assert.deepEqual(await cancellationPlan(member.repository), expectedCancellation);
    assert.deepEqual(expectedCancellation.map((round) => round.subjects[0].formalDate.kind), ['manual', 'manual', 'automatic', 'automatic', 'automatic', 'manual', 'manual', 'manual']);
    await owner.repository.commit([
      change('removal-request-chore', 'chore', 'removal-request', { name: '固定指定の解除申請検査', enabled: true }),
      change('removal-request-cfg', 'chorePolicy', 'removal-request', { configuration: { policy: chorePolicyFromPreset('assigned', ['member']), anchorDate,
        intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
    ]);
    const removalRef = { ...assignmentRef, choreId: 'removal-request' };
    const [lockedRemoval] = await ownerActions.changeDate(removalRef, { mode: 'day', target: day(addLocalDays(anchorDate, 1)),
      options: { strict: true, adminLocked: true }, selector: { scope: 'ongoing', from: anchorDate }, confirmHighLoad: true });
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    const [removalRequest] = await memberActions.cancelDates(removalRef, [lockedRemoval.operationId], {
      selector: { scope: 'period', range: { from: anchorDate, through: addLocalDays(anchorDate, 7) } }, expectedRuleIds: [lockedRemoval.operationId],
    });
    const removalState = async (repository) => (await repository.readState()).assessment.requestStates.find((state) => state.requestId === removalRequest.operationId);
    assert.equal((await removalState(member.repository)).kind, 'pendingDelivery');
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true }); assert.equal((await removalState(owner.repository)).kind, 'awaiting');
    await ownerActions.decide(removalRequest.operationId, 'approve'); assert.equal((await removalState(owner.repository)).kind, 'awaiting');
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true });
    assert.equal((await removalState(member.repository)).formalAction, 'cancel'); assert.equal(hash(owner), hash(member));
    const removalPlan = async (repository) => buildV2CommonPlan(await repository.readState(), { from: anchorDate, through: addLocalDays(anchorDate, 14), asOfDate: anchorDate })
      .occurrences.filter((round) => round.choreId === 'removal-request');
    const expectedRemoval = await removalPlan(owner.repository);
    assert.deepEqual(expectedRemoval.map((round) => round.subjects[0].formalDate.kind), ['automatic', 'automatic', 'manual']);
    const sequence = (await getDocFromServer(f.root)).data().headSequence;
    const approvedSnapshot = await createEncryptedSharedSnapshot(crypto, await loadSharedReplica(owner.database, groupId), await loadSharedFacts(owner.database, groupId),
      next, f.identity, key2, 'approved-requests-v2', sequence, (uid, id, version) => sharedAuthorIdentity([f.roster, next][version - 1], uid, id, version));
    await f.cloud.prepareSnapshot(approvedSnapshot, next); await f.cloud.publishSnapshot(approvedSnapshot.manifest, next);
    restored = device('member', memberIdentity, memberCloud, new Map());
    await initializeV2EventStore(restored.database, { groupId, userId: 'member', householdId: 'local' });
    await restored.sync.sync({ force: true });
    assert.deepEqual(requests(restored), requests(owner)); assert.equal(hash(restored), hash(owner));
    assert.deepEqual((await restored.repository.readState()).assessment.assignmentRequests, (await owner.repository.readState()).assessment.assignmentRequests);
    const rules = (d) => JSON.parse(d.connection.prepare('SELECT formal_rules_json FROM sharing_v2_projection').get().formal_rules_json);
    const firstRule = rules(owner)[0]; assert.ok(firstRule.confirmation); assert.deepEqual(rules(restored), rules(owner));
    assert.equal(firstRule.rule.allowDuringCooldown, true);
    const restoredAssignment = (await restored.repository.readState()).assessment.view.byId(futureAssignment.operationId);
    assert.equal(restoredAssignment.payload.fromAnchorDate, nextAnchor); assert.equal(restoredAssignment.payload.ruleVersion, 2);
    assert.deepEqual(await historicalRound(restored.repository), await historicalRound(owner.repository));
    assert.deepEqual(await cancellationPlan(restored.repository), expectedCancellation);
    assert.deepEqual(await removalPlan(restored.repository), expectedRemoval); assert.equal((await removalState(restored.repository)).formalAction, 'cancel');
    await member.repository.commit([change('next-date-request', 'changeRequest', 'next-date-request', {
      requesterUserId: 'member', choreId: 'approval-floor', anchorDate, occurrenceId: requestOccurrence, subjectUserId: null,
      originalDesignationId: firstRule.operationId, original: firstRule.rule.target, proposed: day(addLocalDays(anchorDate, 5)), proposedMode: 'day',
      proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, basisRuleIds: [firstRule.operationId],
      selector: { scope: 'once', occurrenceId: requestOccurrence, anchorDate }, extensionScope: 'once',
    })]);
    await member.sync.sync({ force: true }); await owner.sync.sync({ force: true });
    await owner.repository.commit([change('next-date-consent', 'requestDecision', 'next-date-consent', {
      requestId: 'next-date-request', decision: 'approve', target: null, referenceDecisionId: null,
    })]);
    await owner.sync.sync({ force: true }); await member.sync.sync({ force: true }); await restored.sync.sync({ force: true });
    for (const d of [member, restored]) { assert.deepEqual(rules(d), rules(owner)); assert.equal(hash(d), hash(owner)); }
    const selected = selectManualRule(rules(restored), { id: requestOccurrence, choreId: 'approval-floor', anchorDate, ruleVersion: 1 }, null, 'Asia/Tokyo');
    assert.equal(selected.kind, 'selected'); assert.deepEqual(selected.fact.rule.target, day(addLocalDays(anchorDate, 5)));
    const planRange = { from: anchorDate, through: addLocalDays(anchorDate, 28), asOfDate: anchorDate };
    const ownerPlan = buildV2CommonPlan(await owner.repository.readState(), planRange);
    for (const d of [member, restored]) assert.deepEqual(buildV2CommonPlan(await d.repository.readState(), planRange), ownerPlan);
    const planned = ownerPlan.occurrences.find((entry) => entry.id === requestOccurrence);
    assert.equal(planned.subjects[0].suggestedDate, addLocalDays(anchorDate, 5));
    assert.deepEqual(ownerPlan.occurrences.find((entry) => entry.choreId === 'approval-floor' && entry.anchorDate === addLocalDays(anchorDate, 7)).assigneeIds, ['owner']);
    for (const d of [owner, member, restored]) assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
    const beforeRemoval = ownerPlan.history;
    await owner.manager.removeMembers(['member']); const removed = await f.cloud.readGroup(groupId);
    assert.equal(removed.roster.body.keyVersion, 3); assert.deepEqual(removed.roster.body.members.map((person) => person.userId), ['owner']);
    await assert.rejects(member.sync.sync({ force: true })); await assertFails(memberCloud.readGroup(groupId));
    assert.deepEqual(buildV2CommonPlan(await owner.repository.readState(), planRange).history, beforeRemoval);
  } finally { owner.connection.close(); member.connection.close(); restored?.connection.close(); }
});
