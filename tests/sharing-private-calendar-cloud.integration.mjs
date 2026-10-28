import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { initializeTestEnvironment } from '@firebase/rules-unit-testing';
import { collection, deleteDoc, doc, getDocFromServer, getDocsFromServer, serverTimestamp, setDoc, updateDoc, writeBatch } from 'firebase/firestore';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { advancePrivateCalendarAuthority, createPrivateCalendarRoot, verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { createPrivateCalendarAccountKey, unwrapPrivateCalendarKey, wrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';
import { createPrivateCalendarCloud } from '../src/platform/sharing/private-calendar-cloud.ts';
import { openPrivateCalendarCache, sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Use the local Firestore emulator only.');
let env;
before(async () => { env = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing', firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await env.clearFirestore(); });
after(async () => { await env?.cleanup(); });
const userId = 'calendar-owner';
function client(uid, changeAtCall = 0, gateway = crypto) {
  const firestore = env.authenticatedContext(uid).firestore(); let current = uid; let calls = 0;
  return { firestore, cloud: createPrivateCalendarCloud(firestore, uid, () => { if (++calls === changeAtCall) current = 'another-user'; return current; }, gateway),
    switch: value => { current = value; }, calls: () => calls };
}
async function fixture() {
  const main = await createDeviceIdentity(crypto); const other = await createDeviceIdentity(crypto);
  const root = await createPrivateCalendarRoot(crypto, userId, main); const left = client(userId);
  assert.equal((await left.cloud.createRoot(root)).created, true);
  return { main, other, root, left, right: client(userId), ref: doc(left.firestore, 'privateCalendars', userId) };
}
async function joined() {
  const h = await fixture(); const authority = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.main.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.root, authority); return { ...h, authority };
}

test('private Calendar Cloud root creation is fixed and idempotent while other users cannot read any private path or enumerate owners', async () => {
  const h = await fixture(); assert.equal((await h.left.cloud.createRoot(h.root)).created, false);
  const head = await h.right.cloud.readHead(); assert.equal(head.rootDigest, h.root.digest); assert.equal(head.cacheHead, null);
  const raw = (await getDocFromServer(h.ref)).data(); assert.equal(JSON.stringify(raw).includes('signingSecretKey'), false);
  const outsider = client('same-group-owner');
  for (const ref of [doc(outsider.firestore, 'privateCalendars', userId), doc(outsider.firestore, 'privateCalendars', userId, 'authorities', '1')]) await assert.rejects(getDocFromServer(ref), { code: 'permission-denied' });
  await assert.rejects(getDocsFromServer(collection(h.left.firestore, 'privateCalendars')), { code: 'permission-denied' });
  await assert.rejects(getDocFromServer(doc(env.unauthenticatedContext().firestore(), 'privateCalendars', userId)), { code: 'permission-denied' });
  await assert.rejects(deleteDoc(h.ref), { code: 'permission-denied' });
  await assert.rejects(updateDoc(h.ref, { rawBusyIntervals: [] }), { code: 'permission-denied' });
  await assert.rejects(setDoc(doc(h.left.firestore, 'privateCalendars', userId, 'authorities', '1'), { authorityJson: 'replace' }), { code: 'permission-denied' });
});

test('private Calendar simultaneous first-device proposals retain exactly one server root and never replace a losing local proposal', async () => {
  const a = await createDeviceIdentity(crypto); const b = await createDeviceIdentity(crypto);
  const first = await createPrivateCalendarRoot(crypto, userId, a); const second = await createPrivateCalendarRoot(crypto, userId, b);
  const left = client(userId); const right = client(userId);
  const results = await Promise.allSettled([left.cloud.createRoot(first), right.cloud.createRoot(second)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1); assert.equal(results.filter(result => result.status === 'rejected').length, 1);
  const head = await left.cloud.readHead(); const winner = head.rootDigest === first.digest ? first : second; const loser = winner === first ? second : first;
  assert.equal((await right.cloud.createRoot(winner)).created, false);
  await assert.rejects(() => right.cloud.createRoot(loser), { code: 'private-calendar/conflict' });
  assert.equal((await left.cloud.readHead()).rootDigest, winner.digest);
});

test('private Calendar authority CAS preserves the signed chain and concurrent main changes remain conflicts rather than last-writer updates', async () => {
  const h = await fixture(); const third = await createDeviceIdentity(crypto);
  const a = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.other.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  const b = advancePrivateCalendarAuthority(h.root, { mainDeviceId: h.main.deviceId, devices: [h.main, third], keyVersion: 1 }, h.main);
  const changes = await Promise.allSettled([h.left.cloud.commitAuthority(h.root, a), h.right.cloud.commitAuthority(h.root, b)]);
  assert.equal(changes.filter(result => result.status === 'fulfilled').length, 1); assert.equal(changes.filter(result => result.status === 'rejected').length, 1);
  const archive = await h.right.cloud.authorityPage(0); assert.equal(archive.authorities.length, 2);
  const root = verifyPrivateCalendarRoot(archive.authorities[0], h.root.anchor); const latest = verifyPrivateCalendarAuthorityUpdate(root, archive.authorities[1]);
  assert.equal(latest.digest, archive.head.authorityDigest);
  assert.equal((await h.left.cloud.commitAuthority(h.root, latest)).head.authorityDigest, latest.digest);
  await assert.rejects(updateDoc(h.ref, { authorityRevision: 50 }), { code: 'permission-denied' });
});

test('private Calendar approved same-UID devices receive the same private key through immutable authenticated envelopes', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  assert.equal(await h.right.cloud.readKey(h.authority, h.other.deviceId), null);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await h.left.cloud.sendKey(h.authority, wrapped); await h.left.cloud.sendKey(h.authority, wrapped);
  const received = await h.right.cloud.readKey(h.authority, h.other.deviceId);
  assert.deepEqual(await unwrapPrivateCalendarKey(crypto, received, h.authority, h.other), key);
  const differentEnvelope = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await assert.rejects(() => h.left.cloud.sendKey(h.authority, differentEnvelope), { code: 'private-calendar/conflict' });
  const outsider = client('another-group-member');
  await assert.rejects(getDocFromServer(doc(outsider.firestore, 'privateCalendars', userId, 'keyEnvelopes', `${h.authority.digest}_${h.other.deviceId}`)), { code: 'permission-denied' });
  const stranger = await createDeviceIdentity(crypto); await assert.rejects(() => h.right.cloud.readKey(h.authority, stranger.deviceId), /未承認/u); key.fill(0);
});

test('private Calendar authority changes retire obsolete wrapped transport copies and revoked devices cannot publish against the old head', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId); await h.left.cloud.sendKey(h.authority, wrapped);
  const removed = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.main.deviceId, devices: [h.main], keyVersion: 2 }, h.main);
  await h.left.cloud.commitAuthority(h.authority, removed);
  await assert.rejects(() => h.right.cloud.sendKey(h.authority, wrapped), { code: 'private-calendar/conflict' });
  await assert.rejects(() => h.right.cloud.readKey(h.authority, h.other.deviceId), { code: 'private-calendar/conflict' });
  const old = await getDocFromServer(doc(h.left.firestore, 'privateCalendars', userId, 'keyEnvelopes', `${h.authority.digest}_${h.other.deviceId}`));
  assert.equal(old.exists(), false); const archive = await h.left.cloud.authorityPage(0); assert.equal(archive.authorities.length, 3); key.fill(0);
});

test('private Calendar Cloud rechecks the account after a committed create and an exact retry recovers the existing root', async () => {
  const identity = await createDeviceIdentity(crypto); const root = await createPrivateCalendarRoot(crypto, userId, identity);
  const interrupted = client(userId, 5);
  await assert.rejects(() => interrupted.cloud.createRoot(root), { code: 'private-calendar/access-denied' });
  const recovered = client(userId); assert.equal((await recovered.cloud.createRoot(root)).created, false);
  assert.equal((await recovered.cloud.readHead()).rootDigest, root.digest);
  recovered.switch('another-user'); await assert.rejects(() => recovered.cloud.readHead(), { code: 'private-calendar/access-denied' });
});

test('private Calendar Cloud rejects malformed public metadata and a substituted signed root never passes the original local trust pin', async () => {
  const h = await fixture();
  await env.withSecurityRulesDisabled(async context => { await updateDoc(doc(context.firestore(), 'privateCalendars', userId), { authorityDigest: '0'.repeat(64) }); });
  await assert.rejects(() => h.left.cloud.readHead(), /公開情報/u);
  const impostor = await createPrivateCalendarRoot(crypto, userId, h.other);
  assert.throws(() => verifyPrivateCalendarRoot(impostor.signed, h.root.anchor), /信頼情報/u);
});

async function cacheFixture(count = 1) {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto); const calendarBinding = 'private-calendar-google-binding';
  const start = Date.parse('2026-10-28T00:00:00.000Z');
  const cache = { ownerUserId: userId, accountGeneration: h.authority.signed.body.accountGeneration, mainDeviceId: h.main.deviceId, mainRevision: 2,
    calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: new Date(start).toISOString(), coverage: { start: new Date(start).toISOString(), end: new Date(start + 30 * 86400000).toISOString() },
    intervals: Array.from({ length: count }, (_, index) => ({ start: new Date(start + index * 120000).toISOString(), end: new Date(start + index * 120000 + 60000).toISOString() })) };
  const seal = (sequence = 1, changes = {}) => sealPrivateCalendarCache(crypto, { cache, authority: h.authority, calendarBinding, accountKey: key, mainDevice: h.main, sequence, ...changes });
  const open = encrypted => openPrivateCalendarCache(crypto, encrypted, { authority: h.authority, calendarBinding, accountKey: key });
  return { ...h, key, calendarBinding, cache, seal, open };
}

test('private Calendar Cloud transfers twenty thousand encrypted intervals to the same approved UID with bounded parts and no public busy content', async () => {
  const h = await cacheFixture(20000); const encrypted = await h.seal(); assert.equal(encrypted.chunks.length, 22);
  assert.equal((await h.left.cloud.uploadCache(h.authority, encrypted)).published, true);
  const received = await h.right.cloud.readCache(h.authority); assert.deepEqual(await h.open(received), h.cache);
  const root = await h.left.cloud.readHead(); assert.equal(root.cacheHead.manifestDigest, sharedDocumentDigest(encrypted.manifest));
  const cacheRef = doc(h.ref, 'caches', root.cacheHead.cacheId); const parts = await getDocsFromServer(collection(cacheRef, 'parts'));
  assert.equal(parts.size, 22); assert.ok(parts.docs.every(part => JSON.stringify(part.data()).length < 141000));
  const serialized = JSON.stringify([root, (await getDocFromServer(cacheRef)).data(), ...parts.docs.map(part => part.data())]);
  for (const privateText of [h.calendarBinding, 'Asia/Tokyo', h.cache.fetchedAt, h.cache.intervals[0].start, h.main.signingSecretKey, Buffer.from(h.key).toString('hex')]) assert.equal(serialized.includes(privateText), false);
  const outsider = client('same-group-owner');
  for (const suffix of [[], ['parts', '0']]) await assert.rejects(getDocFromServer(doc(outsider.firestore, 'privateCalendars', userId, 'caches', root.cacheHead.cacheId, ...suffix)), { code: 'permission-denied' });
  h.key.fill(0);
});

test('private Calendar Cloud uncertain cache delivery recovers the exact saved envelope after an account change without publishing a second cache', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); const interrupted = client(userId, 5);
  await assert.rejects(() => interrupted.cloud.uploadCache(h.authority, encrypted), { code: 'private-calendar/access-denied' });
  assert.equal((await h.right.cloud.uploadCache(h.authority, encrypted)).published, false);
  assert.deepEqual(await h.right.cloud.readCache(h.authority), encrypted);
  assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1); h.key.fill(0);
});

test('private Calendar Cloud publishes and retires derived snapshots atomically and rejects delayed or forked sequences', async () => {
  const h = await cacheFixture(); const first = await h.seal(); const second = await h.seal(2);
  await h.left.cloud.uploadCache(h.authority, first); await h.left.cloud.uploadCache(h.authority, second);
  assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1);
  const old = doc(h.ref, 'caches', first.manifest.body.cacheId); assert.equal((await getDocFromServer(old)).exists(), false);
  assert.equal((await getDocsFromServer(collection(old, 'parts'))).size, 0);
  await assert.rejects(() => h.right.cloud.uploadCache(h.authority, first), { code: 'private-calendar/conflict' });
  const fork = await h.seal(2); await assert.rejects(() => h.right.cloud.uploadCache(h.authority, fork), { code: 'private-calendar/conflict' });
  assert.equal((await h.right.cloud.readHead()).cacheHead.manifestDigest, sharedDocumentDigest(second.manifest)); h.key.fill(0);
});

test('private Calendar Cloud concurrent uploads converge on the highest sequence and same-sequence forks never silently overwrite', async () => {
  const h = await cacheFixture(); const same = await h.seal();
  const duplicate = await Promise.all([h.left.cloud.uploadCache(h.authority, same), h.right.cloud.uploadCache(h.authority, same)]);
  assert.deepEqual(duplicate.map(result => result.published).sort(), [false, true]);
  const a = await h.seal(2); const b = await h.seal(2);
  const fork = await Promise.allSettled([h.left.cloud.uploadCache(h.authority, a), h.right.cloud.uploadCache(h.authority, b)]);
  assert.equal(fork.filter(result => result.status === 'fulfilled').length, 1); assert.equal(fork.filter(result => result.status === 'rejected').length, 1);
  const c = await h.seal(3); const d = await h.seal(4);
  await Promise.allSettled([h.left.cloud.uploadCache(h.authority, c), h.right.cloud.uploadCache(h.authority, d)]);
  assert.equal((await h.right.cloud.readHead()).cacheHead.sequence, 4); assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 1); h.key.fill(0);
});

test('private Calendar Cloud one denied part aborts the entire publication and the previous complete cache remains readable', async () => {
  const h = await cacheFixture(20000); const first = await h.seal(); await h.left.cloud.uploadCache(h.authority, first);
  const next = await h.seal(2); const ref = doc(h.ref, 'caches', next.manifest.body.cacheId); const digest = sharedDocumentDigest(next.manifest);
  const head = { cacheId: next.manifest.body.cacheId, manifestDigest: digest, authorityDigest: h.authority.digest, sequence: 2, chunkCount: next.chunks.length };
  const batch = writeBatch(h.left.firestore);
  batch.set(ref, { schemaVersion: 1, authorityDigest: h.authority.digest, sequence: 2, chunkCount: head.chunkCount, manifestDigest: digest, manifestJson: canonicalJson(next.manifest), createdAt: serverTimestamp() });
  for (const part of next.chunks) batch.set(doc(ref, 'parts', String(part.index)), { schemaVersion: 1, index: part.index, partJson: canonicalJson(part), createdAt: serverTimestamp(), ...(part.index === next.chunks.length - 1 ? { forbiddenPlainBusy: [] } : {}) });
  batch.update(h.ref, { cacheHead: head, updatedAt: serverTimestamp() });
  await assert.rejects(batch.commit(), { code: 'permission-denied' });
  assert.equal((await getDocFromServer(ref)).exists(), false); assert.equal((await getDocsFromServer(collection(ref, 'parts'))).size, 0);
  assert.deepEqual(await h.right.cloud.readCache(h.authority), first); h.key.fill(0);
});

test('private Calendar Cloud missing or altered server parts are unconfirmed and are never returned as an authenticated cache', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); await h.left.cloud.uploadCache(h.authority, encrypted);
  const path = ['privateCalendars', userId, 'caches', encrypted.manifest.body.cacheId, 'parts', '0'];
  await env.withSecurityRulesDisabled(async context => {
    const part = { ...encrypted.chunks[0], encryptedPayload: '0'.repeat(encrypted.chunks[0].encryptedPayload.length) };
    await updateDoc(doc(context.firestore(), ...path), { partJson: canonicalJson(part) });
  });
  await assert.rejects(() => h.right.cloud.readCache(h.authority), /改ざん/u);
  await assert.rejects(() => h.left.cloud.uploadCache(h.authority, encrypted), /欠けているか異なります/u);
  await env.withSecurityRulesDisabled(async context => { await deleteDoc(doc(context.firestore(), ...path)); });
  await assert.rejects(() => h.right.cloud.readCache(h.authority), /揃っていません/u); h.key.fill(0);
});

test('private Calendar Cloud switches main authority before accepting its new cache and rejects every old-main upload', async () => {
  const h = await cacheFixture(); const old = await h.seal(40); await h.left.cloud.uploadCache(h.authority, old);
  const next = advancePrivateCalendarAuthority(h.authority, { mainDeviceId: h.other.deviceId, devices: [h.main, h.other], keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.authority, next);
  assert.equal(await h.right.cloud.readCache(next), null);
  const delayed = await h.seal(41); await assert.rejects(() => h.left.cloud.uploadCache(h.authority, delayed), { code: 'private-calendar/conflict' });
  const changedBody = { ...h.cache, mainDeviceId: h.other.deviceId, mainRevision: 3 };
  const current = await h.seal(1, { authority: next, mainDevice: h.other, cache: changedBody });
  await h.right.cloud.uploadCache(next, current);
  assert.equal((await h.left.cloud.readHead()).cacheHead.sequence, 1);
  assert.deepEqual(await openPrivateCalendarCache(crypto, await h.left.cloud.readCache(next), { authority: next, accountKey: h.key, calendarBinding: h.calendarBinding }), changedBody); h.key.fill(0);
});

test('private Calendar concurrent retries of the same prepared first-device root both recover one immutable acceptance', async () => {
  const identity = await createDeviceIdentity(crypto); const root = await createPrivateCalendarRoot(crypto, userId, identity);
  const left = client(userId); const right = client(userId);
  const accepted = await Promise.all([left.cloud.createRoot(root), right.cloud.createRoot(root)]);
  assert.equal(accepted.length, 2); assert.ok(accepted.every(result => result.head.rootDigest === root.digest));
  assert.equal((await getDocsFromServer(collection(doc(left.firestore, 'privateCalendars', userId), 'authorities'))).size, 1);
});

test('private Calendar concurrent retries of one signed authority update recover the exact archive without advancing another revision', async () => {
  const h = await fixture(); const next = advancePrivateCalendarAuthority(h.root, { devices: [h.main, h.other], mainDeviceId: h.other.deviceId, keyVersion: 1 }, h.main);
  const accepted = await Promise.all([h.left.cloud.commitAuthority(h.root, next), h.right.cloud.commitAuthority(h.root, next)]);
  assert.ok(accepted.every(result => result.head.authorityDigest === next.digest));
  assert.equal((await h.left.cloud.authorityPage(0)).authorities.length, 2);
});

test('private Calendar concurrent retries of the exact prepared key envelope recover its original bytes without replacement', async () => {
  const h = await joined(); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, h.authority, h.main, h.other.deviceId);
  await Promise.all([h.left.cloud.sendKey(h.authority, wrapped), h.right.cloud.sendKey(h.authority, wrapped)]);
  assert.deepEqual(await h.right.cloud.readKey(h.authority, h.other.deviceId), wrapped); key.fill(0);
});

test('private Calendar Cloud maximum device membership rotates without exceeding Rules access limits and removes every old transport key', async () => {
  const h = await fixture(); const devices = [h.main, ...await Promise.all(Array.from({ length: 15 }, () => createDeviceIdentity(crypto)))];
  const joined = advancePrivateCalendarAuthority(h.root, { devices, mainDeviceId: h.main.deviceId, keyVersion: 1 }, h.main);
  await h.left.cloud.commitAuthority(h.root, joined); const key = await createPrivateCalendarAccountKey(crypto);
  const wrapped = await Promise.all(devices.map(device => wrapPrivateCalendarKey(crypto, key, joined, h.main, device.deviceId)));
  await Promise.all(wrapped.map(value => h.left.cloud.sendKey(joined, value)));
  const removed = advancePrivateCalendarAuthority(joined, { devices: [h.main], mainDeviceId: h.main.deviceId, keyVersion: 2 }, h.main);
  await h.left.cloud.commitAuthority(joined, removed);
  const previous = await Promise.all(devices.map(device => getDocFromServer(doc(h.ref, 'keyEnvelopes', `${joined.digest}_${device.deviceId}`))));
  assert.ok(previous.every(value => !value.exists())); assert.equal((await h.right.cloud.readHead()).keyVersion, 2);
  await assert.rejects(() => h.right.cloud.sendKey(joined, wrapped[1]), { code: 'private-calendar/conflict' }); key.fill(0);
});

test('private Calendar Cloud authority history pages at one hundred revisions and never treats server rollback as an empty successful update', async () => {
  const h = await joined(); let current = h.authority;
  for (let index = 0; index < 101; index++) {
    const next = advancePrivateCalendarAuthority(current, { devices: [h.main, h.other], mainDeviceId: current.signed.body.mainDeviceId === h.main.deviceId ? h.other.deviceId : h.main.deviceId, keyVersion: 1 }, h.main);
    await h.left.cloud.commitAuthority(current, next); current = next;
  }
  const first = await h.right.cloud.authorityPage(0); const second = await h.right.cloud.authorityPage(100);
  assert.equal(first.authorities.length, 100); assert.equal(second.authorities.length, 3);
  let verified = verifyPrivateCalendarRoot(first.authorities[0], h.root.anchor);
  for (const signed of [...first.authorities.slice(1), ...second.authorities]) verified = verifyPrivateCalendarAuthorityUpdate(verified, signed);
  assert.equal(verified.digest, current.digest); assert.equal((await h.right.cloud.authorityPage(103)).authorities.length, 0);
  await assert.rejects(() => h.right.cloud.authorityPage(104), { code: 'private-calendar/conflict' });
});

test('private Calendar Cloud account change during Native ciphertext verification prevents every publication write', async () => {
  const h = await cacheFixture(); const encrypted = await h.seal(); let interrupted;
  interrupted = client(userId, 0, { ...crypto, async digestSha256(bytes) {
    interrupted.switch('another-user'); return new Uint8Array(createHash('sha256').update(bytes).digest());
  } });
  await assert.rejects(() => interrupted.cloud.uploadCache(h.authority, encrypted), { code: 'private-calendar/access-denied' });
  assert.equal((await h.left.cloud.readHead()).cacheHead, null); assert.equal((await getDocsFromServer(collection(h.ref, 'caches'))).size, 0); h.key.fill(0);
});

test('private Calendar prepared first-device setup resumes the same real server acceptance from SQLite after a lost reply', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-root-cloud-')); t.after(() => rmSync(directory, { force: true, recursive: true }));
  const path = join(directory, 'prepared.db'); const local = privateCalendarSetupFixture(t, { userId, path }); const remote = client(userId); let drop = true;
  const cloud = { async createRoot(root) { const accepted = await remote.cloud.createRoot(root); if (drop) { drop = false; throw new Error('reply lost after server acceptance'); } return accepted; } };
  await assert.rejects(() => local.controller(cloud).prepareAndResume(), /reply lost/u);
  const prepared = await local.roots.read(); assert.equal((await local.readProtected()).authority, null); assert.equal((await local.readProtected()).hasStoredKeys, false);
  assert.equal((await remote.cloud.readHead()).rootDigest, prepared.digest);
  const restarted = privateCalendarSetupFixture(t, { userId, path, values: local.values, state: local.state });
  assert.equal((await restarted.controller(remote.cloud).resume()).rootDigest, prepared.digest);
  assert.equal((await restarted.roots.read()).status, 'ready'); assert.equal((await restarted.readProtected()).hasCurrentKey, true);
  const generation = local.state.generations; await restarted.controller(remote.cloud).prepareAndResume(); assert.equal(local.state.generations, generation);
});

test('private Calendar a losing first-device setup keeps its local candidate without pinning or generating a key for the winning account root', async t => {
  const winning = await fixture(); const losing = privateCalendarSetupFixture(t, { userId });
  await assert.rejects(() => losing.controller(client(userId).cloud).prepareAndResume(), { code: 'private-calendar/conflict' });
  const intent = await losing.roots.read(); assert.equal(intent.status, 'pending'); assert.notEqual(intent.digest, winning.root.digest);
  assert.equal((await losing.readProtected()).authority, null); assert.equal((await losing.readProtected()).hasStoredKeys, false);
  assert.equal((await winning.left.cloud.readHead()).rootDigest, winning.root.digest);
});

test('private Calendar prepared device changes recover their exact real server receipt after a lost reply and SQL reconstruction', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-control-cloud-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'control.db'); const f = privateCalendarSetupFixture(t, { userId, path }); const native = client(userId);
  await f.controller(native.cloud).prepareAndResume(); const root = await f.secrets.authority(userId); const other = await createDeviceIdentity(crypto); let lose = true;
  const cloud = { ...native.cloud, async commitAuthority(...args) {
    const receipt = await native.cloud.commitAuthority(...args); if (lose) { lose = false; throw new Error('connection lost after device approval'); } return receipt;
  } };
  const sync = h => createPrivateCalendarAuthoritySync({ userId, secrets: h.secrets, intents: h.changes, cloud });
  const change = { mainDeviceId: root.signed.body.mainDeviceId, devices: [...root.signed.body.devices, other], keyVersion: 1 };
  await assert.rejects(() => sync(f).change(change), /connection lost/u); const saved = await f.changes.readPending();
  assert.equal((await f.secrets.authority(userId)).digest, root.digest); assert.equal((await native.cloud.readHead()).authorityDigest, saved.digest);
  const restored = privateCalendarSetupFixture(t, { userId, path, values: f.values, state: f.state });
  const accepted = await sync(restored).resume(); assert.equal(accepted.kind, 'accepted'); assert.equal(accepted.authority.digest, saved.digest);
  assert.equal(await restored.changes.readPending(), null); assert.equal((await native.cloud.authorityPage(0)).authorities.length, 2);
});

test('private Calendar real competing device changes retain the losing draft while verified history follows the server winner', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); await f.controller(left.cloud).prepareAndResume();
  const root = await f.secrets.authority(userId); const identity = await f.secrets.identity(userId); const other = await createDeviceIdentity(crypto);
  const pending = await f.changes.prepare({ mainDeviceId: identity.deviceId, devices: [identity, other], keyVersion: 1 }, identity);
  const winning = advancePrivateCalendarAuthority(root, { mainDeviceId: identity.deviceId, devices: [identity], keyVersion: 2 }, identity);
  await client(userId).cloud.commitAuthority(root, winning);
  const sync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: left.cloud });
  const review = await sync.resume(); assert.equal(review.kind, 'review'); assert.equal(review.intentDigest, pending.digest);
  assert.equal((await f.secrets.authority(userId)).digest, winning.digest); assert.equal((await f.changes.readPending()).digest, pending.digest);
  assert.equal((await f.readProtected()).hasCurrentKey, false); assert.equal((await f.readProtected()).hasStoredKeys, true);
  assert.equal(await sync.dismissReviewed(pending.digest, review.observedCurrentDigest), true); assert.equal(await f.changes.readPending(), null);
  assert.equal((await left.cloud.readHead()).authorityDigest, winning.digest);
});

test('private Calendar receiver rejects a tampered real authority archive before advancing protected state', async t => {
  const f = privateCalendarSetupFixture(t, { userId }); const left = client(userId); await f.controller(left.cloud).prepareAndResume();
  const root = await f.secrets.authority(userId); const identity = await f.secrets.identity(userId);
  const next = advancePrivateCalendarAuthority(root, { mainDeviceId: identity.deviceId, devices: [identity], keyVersion: 2 }, identity);
  await left.cloud.commitAuthority(root, next); const bad = { ...next.signed, signature: '0'.repeat(128) };
  await env.withSecurityRulesDisabled(async context => {
    await updateDoc(doc(context.firestore(), 'privateCalendars', userId, 'authorities', '2'), { authorityJson: canonicalJson(bad), authorityDigest: sharedDocumentDigest(bad) });
  });
  await assert.rejects(() => createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud: left.cloud }).refresh());
  assert.equal((await f.secrets.authority(userId)).digest, root.digest); assert.equal((await f.readProtected()).hasCurrentKey, true);
});
