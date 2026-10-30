import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { before, beforeEach, after, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, serverTimestamp, setDoc, updateDoc, initializeFirestore, connectFirestoreEmulator, terminate } from 'firebase/firestore';
import { initializeApp, deleteApp } from 'firebase/app';
import { createServer, connect } from 'node:net';
import { randomUUID } from 'node:crypto';
import { createPrivateCalendarCloud } from '../src/platform/sharing/private-calendar-cloud.ts';
import { createPrivatePlannerCloud } from '../src/platform/sharing/private-planner-cloud.ts';
import { createDeviceIdentity, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createPrivateCalendarRoot, advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';
import { sealPrivatePreferences, openPrivatePreferences, privatePreferenceCursor, PrivatePreferenceCloudConflict } from '../src/features/sharing/private-planner/preference-crypto.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { privatePlannerSyncFixture, privatePreferenceInput as input } from './helpers/private-planner-sync.mjs';
import { canonicalJson } from '../src/features/sharing/operations.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use the local Firestore emulator only.');
let env; const ownerUserId = 'private-planner-cloud-owner';
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); }); after(async () => { await env?.cleanup(); });
function client(uid = ownerUserId, changeAt = Infinity) {
  let count = 0; const db = env.authenticatedContext(uid).firestore();
  return { db, cloud: createPrivatePlannerCloud(db, uid, () => ++count >= changeAt ? 'another-user' : uid), controls: createPrivateCalendarCloud(db, uid, () => uid, crypto) };
}
async function fixture() {
  const left = client(); const right = client(); const author = await createDeviceIdentity(crypto); const other = await createDeviceIdentity(crypto);
  const root = await createPrivateCalendarRoot(crypto, ownerUserId, author); await left.controls.createRoot(root);
  const authority = advancePrivateCalendarAuthority(root, { mainDeviceId: author.deviceId, devices: [author, other], keyVersion: 1 }, author);
  await left.controls.commitAuthority(root, authority); const key = await crypto.randomBytes(32);
  const seal = (parent = null, preferences = input(), writer = author, a = authority, k = key) => sealPrivatePreferences(crypto, { preferences, authority: a, author: writer, accountKey: k, parent });
  return { left, right, author, other, root, authority, key, seal, ref: doc(left.db, 'privateCalendars', ownerUserId, 'plannerPreferences', 'current') };
}
test('private planner Cloud transfers encrypted settings both ways without exposing plaintext metadata', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); const first = await h.seal(); await h.left.cloud.publish(h.authority, first);
  assert.deepEqual(await openPrivatePreferences(crypto, await h.right.cloud.read(h.authority), h.authority, h.key), input());
  const second = await h.seal(privatePreferenceCursor(first), { ...input(), restDays: [4] }, h.other); await h.right.cloud.publish(h.authority, second);
  assert.deepEqual((await openPrivatePreferences(crypto, await h.left.cloud.read(h.authority), h.authority, h.key)).restDays, [4]);
  const raw = (await getDocFromServer(h.ref)).data();
  for (const value of ['Asia/Tokyo', 'allowedBands', 'restDays', h.author.signingSecretKey, Buffer.from(h.key).toString('hex')]) assert.equal(JSON.stringify(raw).includes(value), false);
  await assert.rejects(getDocsFromServer(collection(h.left.db, 'privateCalendars', ownerUserId, 'plannerPreferences')), { code: 'permission-denied' });
});
test('private planner Rules enforce the private boundary and reject deletion secret fields forged metadata oversized bodies and skipped revisions', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); const first = await h.seal(); await h.left.cloud.publish(h.authority, first);
  for (const who of ['another-member', 'group-owner']) {
    const outsider = client(who); await assert.rejects(getDocFromServer(doc(outsider.db, 'privateCalendars', ownerUserId, 'plannerPreferences', 'current')), { code: 'permission-denied' });
  }
  await assert.rejects(getDocFromServer(doc(env.unauthenticatedContext().firestore(), 'privateCalendars', ownerUserId, 'plannerPreferences', 'current')), { code: 'permission-denied' });
  await assert.rejects(getDocsFromServer(collection(h.left.db, 'privateCalendars', ownerUserId, 'plannerPreferences')), { code: 'permission-denied' });
  await assert.rejects(deleteDoc(h.ref), { code: 'permission-denied' });
  const raw = (await getDocFromServer(h.ref)).data();
  for (const patch of [{ allowedBands: [] }, { accountGeneration: '0'.repeat(64) }, { authorityDigest: '0'.repeat(64) },
    { authorDeviceId: 'unapproved' }, { encryptedJson: 'x'.repeat(24001) }, { keyVersion: 99 }, { parentDigest: '0'.repeat(64), revision: 9 }]) {
    await assert.rejects(updateDoc(h.ref, { ...patch, updatedAt: serverTimestamp() }), { code: 'permission-denied' });
  }
  assert.deepEqual((await getDocFromServer(h.ref)).data(), raw);
});
test('private planner Cloud compare and set permits one initial author and keeps the other independently edited value for explicit review', async t => {
  const h = await privatePlannerSyncFixture(t, { ownerUserId }); const left = client(); const right = client();
  await left.controls.createRoot(h.root); await left.controls.commitAuthority(h.root, h.authority);
  const a = h.service(h.left.f, { cloud: left.cloud }); const b = h.service(h.right.f, { cloud: right.cloud });
  await a.store.save(0, { ...input(), restDays: [1] }); await b.store.save(0, { ...input(), restDays: [2] });
  const results = await Promise.all([a.sync.synchronize(), b.sync.synchronize()]); assert.equal(results.filter(result => result.kind === 'sent').length, 1);
  await a.sync.synchronize(); await b.sync.synchronize(); const views = [await a.sync.readStatus(), await b.sync.readStatus()];
  assert.equal(views.filter(view => view.kind === 'conflict').length, 1); assert.deepEqual(views.map(view => view.local.restDays), [[1], [2]]);
});
test('private planner Cloud exact retry recovers a committed write after account change without a new envelope or server revision', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); const encrypted = await h.seal(); const interrupted = client(ownerUserId, 4);
  await assert.rejects(() => interrupted.cloud.publish(h.authority, encrypted), { code: 'private-planner/access-denied' });
  assert.deepEqual((await h.right.cloud.publish(h.authority, encrypted)), { published: false });
  assert.deepEqual(await h.right.cloud.read(h.authority), encrypted); assert.equal((await getDocFromServer(h.ref)).data().revision, 1);
});
test('private planner Cloud rotation rejects old authority and removed authors while the receiver detects an owner-uploaded forged signature', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); const first = await h.seal(); await h.left.cloud.publish(h.authority, first);
  const oldNext = await h.seal(privatePreferenceCursor(first), input(), h.other);
  const next = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.author.deviceId, devices: [h.author], keyVersion: 2 }, h.author);
  await h.left.controls.commitAuthority(h.authority, next); await assert.rejects(() => h.right.cloud.publish(h.authority, oldNext));
  const key = await crypto.randomBytes(32); t.after(() => key.fill(0)); const current = await h.seal(privatePreferenceCursor(first), input(), h.author, next, key);
  const body = { ...current.body }; const forged = { body, signature: signSharedDocument(body, h.other) }; const raw = (await getDocFromServer(h.ref)).data();
  const packet = { ...raw, authorityDigest: next.digest, keyVersion: 2, authorDeviceId: h.author.deviceId, revision: 2, parentDigest: raw.digest,
    digest: privatePreferenceCursor(forged).digest, encryptedJson: canonicalJson(forged), updatedAt: serverTimestamp() };
  // Rules inspect only the encrypted envelope's metadata. The client must independently verify the pinned author.
  await setDoc(h.ref, packet); const received = await h.right.cloud.read(next);
  await assert.rejects(() => openPrivatePreferences(crypto, received, next, key));
});
test('private planner Cloud keeps one snapshot through one hundred edits and rejects delayed sibling publications', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); let previous = null; let sibling;
  for (let i = 0; i < 100; i++) {
    const next = await h.seal(previous ? privatePreferenceCursor(previous) : null, { ...input(), restDays: [i % 7 + 1] });
    if (i === 1) sibling = await h.seal(privatePreferenceCursor(previous), input());
    await h.left.cloud.publish(h.authority, next); previous = next;
  }
  await assert.rejects(() => h.right.cloud.publish(h.authority, sibling), PrivatePreferenceCloudConflict);
  assert.equal((await getDocFromServer(h.ref)).data().revision, 100);
  await env.withSecurityRulesDisabled(async context => { const documents = await getDocsFromServer(collection(context.firestore(), 'privateCalendars', ownerUserId, 'plannerPreferences')); assert.equal(documents.size, 1); });
});
test('private planner Cloud watch observes confirmed snapshots without repeating equal heads and detaches on cleanup', async t => {
  const h = await fixture(); t.after(() => h.key.fill(0)); let changes = 0; let failed = false;
  const stop = h.right.cloud.watch(() => changes++, () => { failed = true; });
  async function observed(count) { const end = Date.now() + 5000; while (changes < count && !failed && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(failed, false); assert.equal(changes, count); }
  await observed(1); const first = await h.seal(); await h.left.cloud.publish(h.authority, first); await observed(2);
  await h.left.cloud.publish(h.authority, first); assert.equal(changes, 2); stop();
  await h.left.cloud.publish(h.authority, await h.seal(privatePreferenceCursor(first), { ...input(), restDays: [4] }));
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(changes, 2);
});
test('private planner actual SDK offline edits keep protected local values and retry independently before an explicit conflict review', async t => {
  const h = await privatePlannerSyncFixture(t, { ownerUserId }); const left = client(); const right = client();
  await left.controls.createRoot(h.root); await left.controls.commitAuthority(h.root, h.authority);
  // SDK disableNetwork does not stop every transaction RPC in this environment. Cut the actual TCP path instead.
  let offline = false; const sockets = new Set(); const [targetHost, targetPort] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
  const proxy = createServer(socket => {
    if (offline) { socket.destroy(); return; }
    const upstream = connect(Number(targetPort), targetHost); sockets.add(socket); sockets.add(upstream);
    for (const [a, b] of [[socket, upstream], [upstream, socket]]) { a.on('error', () => { a.destroy(); b.destroy(); }); a.on('close', () => { sockets.delete(a); b.destroy(); }); }
    socket.pipe(upstream); upstream.pipe(socket);
  });
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const app = initializeApp({ projectId: 'demo-liflow-sharing', apiKey: 'development-only-emulator', appId: 'development-private-planner-offline' }, `private-offline-${randomUUID()}`);
  const db = initializeFirestore(app, {}); connectFirestoreEmulator(db, '127.0.0.1', proxy.address().port, { mockUserToken: { sub: ownerUserId } });
  t.after(async () => { for (const socket of sockets) socket.destroy(); await terminate(db); await deleteApp(app); await new Promise(resolve => proxy.close(resolve)); });
  const a = h.service(h.left.f, { cloud: createPrivatePlannerCloud(db, ownerUserId, () => ownerUserId) }); const b = h.service(h.right.f, { cloud: right.cloud });
  await a.store.save(0, input()); await a.sync.synchronize(); await b.sync.synchronize();
  offline = true; for (const socket of sockets) socket.destroy();
  await a.store.save(1, { ...input(), restDays: [3] }); await b.store.save(1, { ...input(), restDays: [4] });
  await assert.rejects(() => a.sync.synchronize(), { code: 'unavailable' });
  assert.deepEqual((await a.store.read()).restDays, [3]); assert.deepEqual((await b.store.read()).restDays, [4]); assert.ok((await a.store.readSyncState()).retry);
  offline = false; await a.sync.synchronize(true);
  assert.equal((await b.sync.synchronize(true)).kind, 'conflict'); const view = await b.sync.readStatus();
  assert.deepEqual(view.local.restDays, [4]); assert.deepEqual(view.review.preferences.restDays, [3]);
});
