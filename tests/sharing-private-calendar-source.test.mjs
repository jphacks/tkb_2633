import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarSourceStorage } from '../src/platform/storage/private-calendar-source.ts';
import { createPrivateCalendarSourceController, privateCalendarSourceBinding } from '../src/features/sharing/private-calendar/source-controller.ts';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { advancePrivateCalendarAuthority, createPrivateCalendarRoot, verifyPrivateCalendarAuthorityUpdate } from '../src/features/sharing/private-calendar/authority.ts';
import { createDeviceIdentity, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { sharingTestCrypto } from './helpers/sharing-crypto.mjs';

const userId = 'calendar-source-firebase-owner'; const googleSubject = 'a-distinct-google-subject';

test('private Calendar source epochs reject a non-main signed no-op on receipt while preserving ordinary follower no-ops', async () => {
  const main = await createDeviceIdentity(sharingTestCrypto); const other = await createDeviceIdentity(sharingTestCrypto);
  const root = await createPrivateCalendarRoot(sharingTestCrypto, userId, main);
  const authority = advancePrivateCalendarAuthority(root, { mainDeviceId: main.deviceId, devices: [main, other], keyVersion: 1 }, main);
  const same = { mainDeviceId: main.deviceId, devices: authority.signed.body.devices, keyVersion: 1 };
  assert.equal(advancePrivateCalendarAuthority(authority, same, other), authority);
  const body = { ...authority.signed.body, revision: 3, previousDigest: authority.digest, signerDeviceId: other.deviceId };
  await assert.rejects(async () => verifyPrivateCalendarAuthorityUpdate(authority, { body, signature: signSharedDocument(body, other) }), /取得元.*メイン/u);
});
function services(f, cloud, overrides = {}) {
  const source = createPrivateCalendarSourceStorage({ ownerUserId: userId, assertOwner: owner => assert.equal(f.state.currentUser, owner, 'account changed'),
    readProtected: f.readProtected, exclusive: f.exclusive, vault: overrides.vault ?? f.vault });
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud });
  return { source, authoritySync, controller: createPrivateCalendarSourceController({ userId, secrets: f.secrets, source, intents: f.changes, authoritySync }) };
}
async function fixture(t, options = {}) {
  const f = privateCalendarSetupFixture(t, { userId, ...options }); const h = privateCalendarMemoryCloud(); await f.controller(h.cloud).prepareAndResume();
  return { f, ...h, ...services(f, h.cloud) };
}
function path(t) { const dir = mkdtempSync(join(tmpdir(), 'liflow-private-source-')); t.after(() => rmSync(dir, { recursive: true, force: true })); return join(dir, 'private.db'); }

test('private Calendar source selection is explicit and protected while switching or disabling invalidates the old opaque binding without changing keys', async t => {
  const h = await fixture(t); const original = await h.f.secrets.authority(userId); const values = [...h.f.values]; const allocations = h.f.state.generations;
  assert.equal(await h.source.read(), null); assert.deepEqual([...h.f.values], values); assert.equal(h.f.state.generations, allocations);
  assert.equal((await h.controller.change({ googleSubject }, original.digest)).kind, 'ready');
  const selected = await h.source.read(); const current = await h.f.secrets.authority(userId);
  assert.equal(selected.active.googleSubject, googleSubject); assert.equal(selected.pending, null); assert.equal(current.signed.body.keyVersion, 1);
  assert.notEqual(privateCalendarSourceBinding(original), privateCalendarSourceBinding(current));
  assert.equal(JSON.stringify(h.history).includes(googleSubject), false);
  const sql = h.f.connection.prepare('SELECT authority_json FROM private_calendar_authority_intents').all(); assert.equal(JSON.stringify(sql).includes(googleSubject), false);
  const count = h.history.length; await h.controller.change({ googleSubject }, current.digest); assert.equal(h.history.length, count);
  await h.controller.change({ googleSubject: null }, current.digest); const disabled = await h.source.read(); assert.equal(disabled.active.googleSubject, null);
  const latest = await h.f.secrets.authority(userId); assert.equal(latest.signed.body.keyVersion, 1); assert.notEqual(privateCalendarSourceBinding(current), privateCalendarSourceBinding(latest));
  const retained = await h.f.secrets.currentKey(userId, latest); assert.equal(retained.length, 32); retained.fill(0);
});

test('private Calendar pending source survives real SQL reconstruction and a lost server reply without rebinding to Firebase UID or advancing another revision', async t => {
  const file = path(t); const h = await fixture(t, { path: file }); const before = await h.f.secrets.authority(userId); h.flags.controlReplyLost = true;
  await assert.rejects(() => h.controller.change({ googleSubject }, before.digest), /lost approval/u);
  const pending = await h.source.read(); assert.equal(pending.active, null); assert.equal(pending.pending.choice.googleSubject, googleSubject); assert.equal(h.history.length, 2);
  const restarted = privateCalendarSetupFixture(t, { userId, path: file, values: h.f.values, state: h.f.state }); const fresh = services(restarted, h.cloud);
  assert.equal((await fresh.controller.resume()).kind, 'ready'); assert.equal((await fresh.source.read()).active.googleSubject, googleSubject);
  assert.equal(h.history.length, 2); assert.equal((await fresh.source.read()).pending, null); assert.equal(await restarted.changes.readPending(), null);
});

test('private Calendar source recovers a receipt committed before its protected profile write and cannot cancel an already accepted binding', async t => {
  const h = await fixture(t); let fail = true;
  const s = services(h.f, h.cloud, { vault: { getItem: key => h.f.vault.getItem(key), setItem: async (key, raw) => {
    const body = JSON.parse(raw); if (fail && body.active && body.pending === null) { fail = false; throw new Error('protected source receipt interrupted'); } await h.f.vault.setItem(key, raw);
  } } });
  const initial = await h.f.secrets.authority(userId); await assert.rejects(() => s.controller.change({ googleSubject }, initial.digest), /interrupted/u);
  const pending = (await h.source.read()).pending; const current = await h.f.secrets.authority(userId); assert.equal(await h.f.changes.readPending(), null);
  await assert.rejects(() => h.controller.dismissReviewed(pending.digest, current.digest), /受付済み/u);
  assert.equal((await h.controller.resume()).kind, 'ready'); assert.equal((await h.source.read()).active.googleSubject, googleSubject); assert.equal(h.history.length, 2);
});

test('private Calendar source pending write is retained after an owner switch and mutable caller settings cannot substitute the selected account', async t => {
  const h = await fixture(t); const original = await h.f.secrets.authority(userId); let swap = true;
  const s = services(h.f, h.cloud, { vault: { getItem: key => h.f.vault.getItem(key), setItem: async (key, raw) => {
    await h.f.vault.setItem(key, raw); if (swap) { swap = false; h.f.state.currentUser = 'foreign-owner'; }
  } } });
  const selected = { googleSubject }; const call = s.controller.change(selected, original.digest); selected.googleSubject = 'substituted-subject';
  await assert.rejects(() => call, /account changed/u); assert.equal(h.history.length, 1);
  h.f.state.currentUser = userId; assert.equal((await h.source.read()).pending.choice.googleSubject, googleSubject);
  await h.controller.resume(); assert.equal((await h.source.read()).active.googleSubject, googleSubject); assert.equal(h.history.length, 2);
});

test('private Calendar conflicting source proposals remain blocked until review and preserve the previously accepted source and all device keys', async t => {
  const h = await fixture(t); await h.controller.change({ googleSubject }, (await h.f.secrets.authority(userId)).digest);
  const before = await h.f.secrets.authority(userId); const identity = await h.f.secrets.identity(userId); const body = before.signed.body;
  const target = advancePrivateCalendarAuthority(before, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion }, identity, { purpose: 'calendarSourceChange' });
  await h.source.prepare(target.signed, { googleSubject: 'new-subject' });
  const winner = advancePrivateCalendarAuthority(before, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: 2 }, identity); await h.cloud.commitAuthority(before, winner);
  const review = await h.controller.resume(); assert.equal(review.kind, 'review'); assert.equal((await h.source.read()).active.googleSubject, googleSubject); assert.ok((await h.source.read()).pending);
  await assert.rejects(() => h.controller.dismissReviewed(target.digest, before.digest), /変わりました/u);
  assert.equal((await h.controller.dismissReviewed(target.digest, review.observedCurrentDigest)).kind, 'dismissed');
  assert.equal((await h.source.read()).pending, null); assert.equal((await h.source.read()).active.googleSubject, googleSubject); assert.equal((await h.f.readProtected()).hasStoredKeys, true);
});

test('private Calendar source never changes a non-main or stale view and rejects unrelated authority changes before writing a profile', async t => {
  const h = await fixture(t); const initial = await h.f.secrets.authority(userId); const identity = await h.f.secrets.identity(userId); const other = await createDeviceIdentity(sharingTestCrypto);
  const changed = advancePrivateCalendarAuthority(initial, { devices: [identity, other], mainDeviceId: other.deviceId, keyVersion: 1 }, identity); await h.cloud.commitAuthority(initial, changed); await h.authoritySync.refresh();
  await assert.rejects(() => h.controller.change({ googleSubject }, initial.digest), /表示後/u);
  await assert.rejects(() => h.controller.change({ googleSubject }, changed.digest), /メイン/u);
  assert.equal(await h.source.read(), null); assert.equal(h.history.length, 2);
});

test('private Calendar corrupt source profiles fail closed and cannot replace the retained subject identity or keys', async t => {
  const h = await fixture(t); await h.controller.change({ googleSubject }, (await h.f.secrets.authority(userId)).digest);
  const name = `private-calendar-source:${userId}`; const original = await h.f.vault.getItem(name); const identity = (await h.f.secrets.identity(userId)).deviceId;
  await h.f.vault.setItem(name, '{corrupt'); await assert.rejects(() => h.source.read()); await assert.rejects(() => h.controller.resume());
  assert.equal(await h.f.vault.getItem(name), '{corrupt'); await h.f.vault.setItem(name, original);
  assert.equal((await h.source.read()).active.googleSubject, googleSubject); assert.equal((await h.f.secrets.identity(userId)).deviceId, identity);
});

test('private Calendar explicit source epochs preserve ordinary no-op authority behavior and cannot mix main membership or key changes', async t => {
  const h = await fixture(t); const current = await h.f.secrets.authority(userId); const identity = await h.f.secrets.identity(userId); const body = current.signed.body;
  const same = { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion };
  assert.equal(advancePrivateCalendarAuthority(current, same, identity).digest, current.digest);
  const epoch = advancePrivateCalendarAuthority(current, same, identity, { purpose: 'calendarSourceChange' });
  assert.equal(epoch.signed.body.revision, body.revision + 1); assert.equal(epoch.signed.body.keyVersion, body.keyVersion);
  assert.throws(() => advancePrivateCalendarAuthority(current, { ...same, keyVersion: body.keyVersion + 1 }, identity, { purpose: 'calendarSourceChange' }), /分けて/u);
  assert.throws(() => advancePrivateCalendarAuthority(current, same, identity, { purpose: 'somethingElse' }), /目的/u);
  const other = await createDeviceIdentity(sharingTestCrypto); assert.throws(() => advancePrivateCalendarAuthority(current, { ...same, devices: [identity,other] }, identity, { purpose: 'calendarSourceChange' }), /分けて/u);
  assert.equal(h.history.length, 1); assert.equal(await h.source.read(), null);
});

test('private Calendar source allowlist and receipt guards reject tokens unrelated device changes and acceptance before a verified checkpoint', async t => {
  const h = await fixture(t); const current = await h.f.secrets.authority(userId); const identity = await h.f.secrets.identity(userId); const body = current.signed.body;
  assert.throws(() => h.controller.change({ googleSubject, accessToken: 'never-store-this' }, current.digest));
  const changed = advancePrivateCalendarAuthority(current, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: 2 }, identity);
  await assert.rejects(() => h.source.prepare(changed.signed, { googleSubject }), /混ぜる/u); assert.equal(await h.source.read(), null);
  const epoch = advancePrivateCalendarAuthority(current, { devices: body.devices, mainDeviceId: body.mainDeviceId, keyVersion: body.keyVersion }, identity, { purpose: 'calendarSourceChange' });
  await h.source.prepare(epoch.signed, { googleSubject }); assert.equal(await h.source.commitAccepted(epoch.digest, current.digest), false);
  assert.equal((await h.source.read()).active, null); assert.ok((await h.source.read()).pending); assert.equal(h.history.length, 1);
});
