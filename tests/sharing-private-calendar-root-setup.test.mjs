import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createPrivateCalendarRoot, advancePrivateCalendarAuthority, verifyPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';

function cloudFixture() {
  let accepted = null; let calls = 0;
  return { calls: () => calls, head: () => accepted, async createRoot(root) {
    calls++; if (accepted) assert.equal(root.digest, accepted.rootDigest, 'a retry may not generate a replacement root');
    accepted ??= privateCalendarCloudFields(root); return { head: accepted };
  } };
}
function fileFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-root-setup-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  return join(directory, 'private-root.db');
}

test('private Calendar first-device setup stores its exact public intent before server acceptance and commits one durable pin and key', async t => {
  const f = privateCalendarSetupFixture(t); const cloud = cloudFixture();
  const ready = await f.controller(cloud).prepareAndResume(); const intent = await f.roots.read();
  assert.equal(ready.rootDigest, intent.digest); assert.equal(intent.status, 'ready'); assert.equal(cloud.calls(), 1); assert.equal(f.state.generations, 4);
  const state = await f.readProtected(); assert.equal(state.authority.digest, intent.digest); assert.equal(state.hasCurrentKey, true);
  const identity = await f.secrets.identity(f.userId); const row = f.connection.prepare('SELECT * FROM private_calendar_root_setup').get();
  for (const secret of [identity.signingSecretKey, identity.agreementSecretKey]) assert.equal(JSON.stringify(row).includes(secret), false);
  assert.deepEqual(await f.controller(cloud).resume(), ready); assert.equal(cloud.calls(), 1); assert.equal(f.state.generations, 4);
});

test('private Calendar a lost server create reply survives process reconstruction with the exact root and no premature pin or data key', async t => {
  const path = fileFixture(t); const f = privateCalendarSetupFixture(t, { path }); const server = cloudFixture(); let loseReply = true;
  const cloud = { async createRoot(root) { const response = await server.createRoot(root); if (loseReply) { loseReply = false; throw new Error('connection lost after durable server acceptance'); } return response; } };
  await assert.rejects(() => f.controller(cloud).prepareAndResume(), /connection lost/u);
  const prepared = await f.roots.read(); assert.equal(prepared.status, 'pending'); assert.equal(f.state.generations, 3);
  assert.equal((await f.readProtected()).authority, null); assert.equal((await f.readProtected()).hasStoredKeys, false);
  const restarted = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state });
  const ready = await restarted.controller(cloud).resume(); assert.equal(ready.rootDigest, prepared.digest); assert.equal(server.calls(), 2);
  assert.equal(f.state.generations, 4); assert.equal((await restarted.roots.read()).status, 'ready');
  assert.equal((await restarted.secrets.authority(f.userId)).digest, prepared.digest);
});

test('private Calendar parallel first-device setup runtimes share one SQL lock and cannot create competing roots or duplicate keys', async t => {
  const path = fileFixture(t); const left = privateCalendarSetupFixture(t, { path });
  const right = privateCalendarSetupFixture(t, { path, values: left.values, state: left.state }); const cloud = cloudFixture();
  const [a, b] = await Promise.all([left.controller(cloud).prepareAndResume(), right.controller(cloud).prepareAndResume()]);
  assert.equal(a.rootDigest, b.rootDigest); assert.equal(left.state.generations, 4); assert.ok(cloud.calls() >= 1 && cloud.calls() <= 2);
  const state = JSON.parse(await left.vault.getItem(`private-calendar-state:${left.userId}`)); assert.equal(state.keys.length, 1);
  assert.equal(left.connection.prepare('SELECT count(*) AS n FROM private_calendar_root_setup').get().n, 1);
});

test('private Calendar first-device setup leaves trust and data-key generation pending until the actual server acceptance resolves', async t => {
  const f = privateCalendarSetupFixture(t); let release; let entered; let proposed;
  const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
  const pending = f.controller({ async createRoot(root) { proposed = root; entered(); await gate; return { head: privateCalendarCloudFields(root) }; } }).prepareAndResume();
  await ready; assert.equal((await f.readProtected()).authority, null); assert.equal((await f.readProtected()).hasStoredKeys, false);
  assert.equal(await f.roots.markReady(proposed.digest), false); assert.equal((await f.roots.read()).status, 'pending');
  release(); assert.equal((await pending).rootDigest, proposed.digest); assert.equal((await f.roots.read()).status, 'ready');
});

test('private Calendar a failure after data-key storage retries only finalization and clears the unreturned temporary key', async t => {
  let rejectReady = true;
  const path = fileFixture(t); const f = privateCalendarSetupFixture(t, { path, decorate: database => ({ ...database, async runAsync(sql, ...args) {
    if (rejectReady && sql.startsWith('UPDATE private_calendar_root_setup')) throw new Error('SQLITE_BUSY finalization interrupted'); return database.runAsync(sql, ...args);
  } }) });
  let returnedKey; const createKey = f.secrets.createCurrentKey;
  f.secrets.createCurrentKey = async (...args) => { returnedKey = await createKey(...args); return returnedKey; };
  const cloud = cloudFixture(); await assert.rejects(() => f.controller(cloud).prepareAndResume(), /finalization interrupted/u);
  assert.ok(returnedKey.every(byte => byte === 0)); assert.equal((await f.roots.read()).status, 'pending');
  const authority = await f.secrets.authority(f.userId); const existing = await f.secrets.currentKey(f.userId, authority);
  const generations = f.state.generations; rejectReady = false;
  const restored = privateCalendarSetupFixture(t, { path, values: f.values, state: f.state }); await restored.controller(cloud).resume();
  assert.equal(f.state.generations, generations); assert.deepEqual(await restored.secrets.currentKey(f.userId, authority), existing); existing.fill(0);
});

test('private Calendar committed root intents remain recoverable after an account switch and cannot leak their result to the new account', async t => {
  const f = privateCalendarSetupFixture(t); const identity = await f.secrets.identity(f.userId);
  let once = true; f.state.afterCommit = () => {
    const table = f.connection.prepare("SELECT name FROM sqlite_master WHERE name = 'private_calendar_root_setup'").get();
    if (once && table && f.connection.prepare('SELECT id FROM private_calendar_root_setup').get()) { once = false; f.state.currentUser = 'different-user'; }
  };
  await assert.rejects(() => f.roots.prepare(identity), /account changed/u);
  assert.equal(f.connection.prepare('SELECT status FROM private_calendar_root_setup').get().status, 'pending');
  await assert.rejects(() => f.roots.read(), /account changed/u);
  f.state.currentUser = f.userId; f.state.afterCommit = null; const prepared = await f.roots.read();
  const generations = f.state.generations; assert.equal((await f.controller(cloudFixture()).resume()).rootDigest, prepared.digest); assert.equal(f.state.generations, generations + 1);
});

test('private Calendar malformed saved root intents fail closed without generating a replacement or changing the original device identity', async t => {
  const f = privateCalendarSetupFixture(t); const identity = await f.secrets.identity(f.userId); const prepared = await f.roots.prepare(identity);
  const before = f.connection.prepare('SELECT * FROM private_calendar_root_setup').get();
  const stranger = await createDeviceIdentity(crypto); const other = await createPrivateCalendarRoot(crypto, f.userId, stranger);
  for (const patch of [{ intent_digest: prepared.digest, authority_json: '{}' }, { intent_digest: '0'.repeat(64), authority_json: before.authority_json },
    { intent_digest: other.digest, authority_json: JSON.stringify(other.signed) }]) {
    f.connection.prepare('UPDATE private_calendar_root_setup SET intent_digest = ?, authority_json = ?').run(patch.intent_digest, patch.authority_json);
    const generations = f.state.generations; await assert.rejects(() => f.roots.read()); await assert.rejects(() => f.roots.prepare(identity));
    assert.equal(f.state.generations, generations); assert.equal((await f.secrets.identity(f.userId)).deviceId, identity.deviceId); assert.equal((await f.readProtected()).authority, null);
  }
  f.connection.prepare('UPDATE private_calendar_root_setup SET intent_digest = ?, authority_json = ?').run(before.intent_digest, before.authority_json);
  assert.equal((await f.roots.read()).digest, prepared.digest);
});

test('private Calendar old ciphertext without its protected trust blocks automatic first-device reinitialization and preserves the old SQL row', async t => {
  const f = privateCalendarSetupFixture(t); const identity = await f.secrets.identity(f.userId);
  f.connection.exec("CREATE TABLE private_calendar_cache (id TEXT); INSERT INTO private_calendar_cache VALUES ('old-ciphertext');");
  const generations = f.state.generations; await assert.rejects(() => f.roots.prepare(identity), /以前の本人用データ/u);
  assert.equal(f.state.generations, generations); assert.equal(f.connection.prepare('SELECT id FROM private_calendar_cache').get().id, 'old-ciphertext');
  assert.equal((await f.readProtected()).authority, null);
});

test('private Calendar a different or advanced server root cannot finalize a prepared first-device pin or generate its data key', async t => {
  const f = privateCalendarSetupFixture(t); const identity = await f.secrets.identity(f.userId); const prepared = await f.roots.prepare(identity);
  const other = await createDeviceIdentity(crypto); const replacement = await createPrivateCalendarRoot(crypto, f.userId, other);
  await assert.rejects(() => f.controller({ createRoot: async () => ({ head: privateCalendarCloudFields(replacement) }) }).resume(), { code: 'private-calendar/conflict' });
  const original = verifyPrivateCalendarRoot(prepared.signed, { ownerUserId: f.userId, accountGeneration: prepared.signed.body.accountGeneration, rootDigest: prepared.digest });
  const advanced = advancePrivateCalendarAuthority(original, { devices: [identity, other], mainDeviceId: other.deviceId, keyVersion: 1 }, identity);
  await assert.rejects(() => f.controller({ createRoot: async () => ({ head: privateCalendarCloudFields(advanced) }) }).resume(), { code: 'private-calendar/conflict' });
  assert.equal((await f.roots.read()).digest, prepared.digest); assert.equal((await f.roots.read()).status, 'pending');
  assert.equal((await f.readProtected()).authority, null); assert.equal((await f.readProtected()).hasStoredKeys, false);
});

test('private Calendar first-device setup is explicit and a bare resume cannot generate an identity, trust pin or key', async t => {
  const f = privateCalendarSetupFixture(t); const cloud = cloudFixture(); const controller = f.controller(cloud);
  assert.equal(f.state.generations, 0); assert.equal(f.values.size, 0);
  await assert.rejects(() => controller.resume(), /準備/u); assert.equal(f.state.generations, 0); assert.equal(f.values.size, 0); assert.equal(cloud.calls(), 0);
});
