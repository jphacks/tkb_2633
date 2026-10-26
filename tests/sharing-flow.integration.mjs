import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, doc, getDocsFromServer, Timestamp, writeBatch } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { createSharedJoinRequest, parseSharedInvitation } from '../src/features/sharing/invitations.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { testSharedClient } from './helpers/shared-client.mjs';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run against the local Firestore emulator.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
const cloudFor = (uid) => createSharingCloud(env.authenticatedContext(uid).firestore(), uid, () => uid);
async function fixture(memberId = 'member') {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const roster = createSharedRoster('group-flow', 'owner', owner); const cloud = cloudFor('owner');
  await cloud.createGroup(roster, await wrapGroupKey(crypto, 'group-flow', 1, key, owner, owner, 'owner'));
  const a = await testSharedClient({ userId: 'owner', groupId: 'group-flow', identity: owner, cloud, anchor: roster, key, bootstrap: true });
  await a.sync(); const invitation = await a.manager.createInvitation();
  assert.deepEqual(parseSharedInvitation(invitation.url, Date.now()), { invitation: invitation.invitation, seed: invitation.seed });
  const memberCloud = cloudFor(memberId); const request = createSharedJoinRequest(invitation, memberId, member, Date.now());
  await memberCloud.submitJoinRequest(invitation.invitation, request);
  const b = await testSharedClient({ userId: memberId, groupId: 'group-flow', identity: member, cloud: memberCloud, anchor: invitation.invitation.body.pin });
  return { a, b, owner, member, memberId, invitation, request, cloud, memberCloud };
}

test('real Firestore Rules + SQLite planner: explicit approval, concurrent edits/completion, undo, handover and departure converge without merging personal data', async () => {
  const f = await fixture(); const { a, b } = f; const choreId = 'group-flow.builtin-chore-08';
  try {
    assert.equal((await b.sync()).waitingForApproval, true);
    await a.manager.approve(f.invitation.invitation, f.request); await b.sync();
    assert.equal((await a.snapshot()).chores.length, 20); assert.equal((await b.snapshot()).chores.length, 20);
    assert.equal((await b.checkpoint()).snapshotId, (await f.cloud.readGroup('group-flow')).group.snapshotId);
    await a.repository.setChoreEnabled(a.database, choreId, true); await a.sync(); await b.sync();
    assert.equal((await a.snapshot()).scheduleEntries[0].id, (await b.snapshot()).scheduleEntries[0].id);
    await Promise.all([a.repository.updateChoreSettings(a.database, choreId, { cycleDays: 17 }), b.repository.updateChoreSettings(b.database, choreId, { cycleDays: 9 })]);
    await a.sync(); await b.sync(); await a.sync();
    assert.ok((await a.snapshot()).sharing.issues.some((issue) => issue.kind === 'conflict'));
    assert.deepEqual((await a.replica()).entities, (await b.replica()).entities);
    assert.equal((await a.snapshot()).scheduleEntries.length, 0);
    await a.repository.updateChoreSettings(a.database, choreId, { cycleDays: 17 }); await a.sync(); await b.sync();
    assert.equal((await a.snapshot()).sharing.issues.length, 0);
    const aEntry = (await a.snapshot()).scheduleEntries[0]; const bEntry = (await b.snapshot()).scheduleEntries[0];
    await Promise.all([a.repository.completeChore(a.database, aEntry), b.repository.completeChore(b.database, bEntry)]);
    await a.sync(); await b.sync(); await a.sync();
    assert.equal((await a.snapshot()).completions.filter((item) => item.outcome === 'completed').length, 1);
    assert.equal((await a.replica()).completions[0].activeOperationIds.length, 2);
    await a.repository.undoCompletedChore(a.database, (await a.snapshot()).completions[0].id); await a.sync(); await b.sync();
    assert.equal((await b.snapshot()).completions[0].outcome, 'incomplete'); assert.equal((await b.snapshot()).scheduleEntries[0].id, aEntry.id);
    await a.manager.transferOwnership({ userId: 'member', deviceId: f.member.deviceId }); await b.sync();
    assert.equal(b.roster().body.ownerUserId, 'member'); assert.equal(b.roster().body.keyVersion, 3);
    await a.repository.updateChoreSettings(a.database, choreId, { load: 'heavy' });
    await a.manager.leave(); await assert.rejects(b.sync(), { code: 'sharing/key-version-changed' });
    await b.manager.repairDepartures(); await b.sync();
    assert.equal(b.roster().body.keyVersion, 4); assert.equal((await b.snapshot()).completions.length, 1);
    assert.deepEqual(b.roster().body.members.map((member) => member.userId), ['member']);
    await assert.rejects(f.cloud.readGroup('group-flow')); await assert.rejects(a.sync());
    assert.equal((await a.checkpoint()).pendingCount, 1);
    assert.equal((await b.snapshot()).chores.find((chore) => chore.id === choreId).load, 'normal');
    assert.equal((await b.checkpoint()).pendingCount, 0);
  } finally { a.close(); b.close(); }
});

test('removing a secondary device rotates keys and preserves the same-account owner and shared state', async () => {
  const f = await fixture('owner');
  try {
    await f.a.manager.approve(f.invitation.invitation, f.request); await f.b.sync();
    const before = f.a.roster().body.keyVersion;
    await f.a.manager.removeDevice(f.member.deviceId);
    const next = await f.cloud.readGroup('group-flow');
    assert.equal(next.group.keyVersion, before + 1);
    assert.deepEqual(next.roster.body.members[0].devices.map((d) => d.identity.deviceId), [f.owner.deviceId]);
    assert.equal((await f.a.snapshot()).chores.length, 20);
    await assert.rejects(f.b.sync());
    await assert.rejects(f.a.manager.removeDevice(f.owner.deviceId), /owner device/);
  } finally { f.a.close(); f.b.close(); }
});

test('a removed member rejoins with a fresh approved device and snapshot while its old offline outbox stays isolated', async () => {
  const f = await fixture(); let fresh;
  try {
    await f.a.manager.approve(f.invitation.invitation, f.request); await f.b.sync();
    const choreId = 'group-flow.builtin-chore-08';
    await f.b.repository.updateChoreSettings(f.b.database, choreId, { cycleDays: 17 });
    const pending = (await f.b.checkpoint()).pendingCount; assert.ok(pending > 0);
    await f.a.manager.removeMembers(['member']);
    const invite = await f.a.manager.createInvitation(); const identity = await createDeviceIdentity(crypto);
    const request = createSharedJoinRequest(invite, 'member', identity, Date.now());
    await f.memberCloud.submitJoinRequest(invite.invitation, request);
    fresh = await testSharedClient({ userId: 'member', groupId: 'group-flow', identity, cloud: f.memberCloud, anchor: f.b.record().anchor });
    await f.a.manager.approve(invite.invitation, request); await fresh.sync();
    assert.equal((await fresh.snapshot()).chores.find((item) => item.id === choreId).recommendedCycleDays, undefined);
    await assert.rejects(f.b.sync()); assert.equal((await f.b.checkpoint()).pendingCount, pending);
    await fresh.repository.updateChoreSettings(fresh.database, choreId, { cycleDays: 9 }); await fresh.sync(); await f.a.sync();
    assert.equal((await f.a.snapshot()).chores.find((item) => item.id === choreId).recommendedCycleDays, 9);
    assert.equal((await fresh.checkpoint()).pendingCount, 0);
  } finally { fresh?.close(); f.a.close(); f.b.close(); }
});

test('an additional device on the same Google identity still requires explicit approval and retains an independent author sequence', async () => {
  const f = await fixture('owner'); const { a, b } = f;
  try {
    assert.equal((await b.sync()).waitingForApproval, true);
    await a.manager.approve(f.invitation.invitation, f.request); await b.sync();
    assert.equal(b.roster().body.members.length, 1); assert.equal(b.roster().body.members[0].devices.length, 2);
    const id = 'group-flow.builtin-chore-07';
    await b.repository.setChoreEnabled(b.database, id, true); await b.sync(); await a.sync();
    assert.deepEqual((await a.snapshot()).scheduleEntries, (await b.snapshot()).scheduleEntries);
    assert.ok((await a.replica()).frontier[f.member.deviceId] > 0); assert.ok((await a.replica()).frontier[f.owner.deviceId] > 0);
    assert.equal((await a.replica()).pendingOperationIds.length, 0);
  } finally { a.close(); b.close(); }
});

test('cancelling a request before approval is atomic; cancellation after approval cannot pretend to remove an authorized member', async () => {
  const f = await fixture(); const { a, b } = f;
  try {
    assert.equal(await f.memberCloud.cancelOwnJoinRequest(f.invitation.invitation, f.request), true);
    assert.equal((await f.cloud.listJoinRequests(f.invitation.invitation)).requests.length, 0);
    await assert.rejects(a.manager.approve(f.invitation.invitation, f.request));
    assert.equal((await f.cloud.readGroup('group-flow')).group.keyVersion, 1);
    const invite = await a.manager.createInvitation(); const request = createSharedJoinRequest(invite, 'member', f.member, Date.now());
    await f.memberCloud.submitJoinRequest(invite.invitation, request); await a.manager.approve(invite.invitation, request);
    assert.equal(await f.memberCloud.cancelOwnJoinRequest(invite.invitation, request), false);
    assert.ok((await f.memberCloud.readGroup('group-flow')).group.memberIds.includes('member'));
  } finally { a.close(); b.close(); }
});

test('acknowledged snapshots compact old events and a device with an empty SQLite cache restores the full shared state', async () => {
  const f = await fixture(); const { a, b } = f; let restored;
  try {
    await a.manager.approve(f.invitation.invitation, f.request); await b.sync();
    await a.manager.publishSnapshot();
    const result = await f.cloud.compactHistory('group-flow'); assert.ok(result.deleted > 0); assert.equal(result.waitingForDevices, false);
    assert.equal((await getDocsFromServer(collection(env.authenticatedContext('owner').firestore(), 'sharingGroups', 'group-flow', 'events'))).size, 0);
    restored = await testSharedClient({ userId: 'member', groupId: 'group-flow', identity: f.member, cloud: f.memberCloud, anchor: f.invitation.invitation.body.pin });
    await restored.sync(); assert.deepEqual((await restored.snapshot()).chores, (await b.snapshot()).chores);
    assert.equal((await restored.checkpoint()).sequence, (await a.checkpoint()).sequence);
    assert.equal((await restored.replica()).operationIndex.length, (await a.replica()).operationIndex.length);
  } finally { restored?.close(); a.close(); b.close(); }
});

test('a perpetually offline device cannot make the cloud log grow forever when newer snapshots keep resetting the snapshot date', async () => {
  const f = await fixture(); const { a, b } = f;
  try {
    await a.manager.approve(f.invitation.invitation, f.request); await a.manager.publishSnapshot();
    const first = await f.cloud.compactHistory('group-flow'); assert.equal(first.waitingForDevices, true); assert.equal(first.deleted, 0);
    await env.withSecurityRulesDisabled(async (context) => {
      const store = context.firestore(); const events = await getDocsFromServer(collection(store, 'sharingGroups', 'group-flow', 'events'));
      const batch = writeBatch(store); for (const event of events.docs) batch.update(doc(store, event.ref.path), { createdAt: Timestamp.fromMillis(Date.now() - 8 * 86400000) });
      await batch.commit();
    });
    await a.manager.publishSnapshot();
    const second = await f.cloud.compactHistory('group-flow'); assert.ok(second.deleted >= 42); assert.equal(second.waitingForDevices, true);
    assert.equal((await getDocsFromServer(collection(env.authenticatedContext('owner').firestore(), 'sharingGroups', 'group-flow', 'events'))).size, 0);
    await b.sync(); assert.equal((await b.snapshot()).chores.length, 20);
    assert.equal((await b.replica()).pendingOperationIds.length, 0);
  } finally { a.close(); b.close(); }
});
