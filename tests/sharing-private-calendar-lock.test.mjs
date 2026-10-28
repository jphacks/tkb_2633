import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDatabase } from './helpers/sqlite.mjs';
import { createPrivateCalendarExclusiveStorage } from '../src/platform/storage/private-calendar-store.ts';
import { privateCalendarDatabaseFilename } from '../src/features/sharing/private-calendar/database-name.ts';
import { createPrivateCalendarSecretStore } from '../src/features/sharing/private-calendar/secret-store.ts';
import { createSecureVault } from '../src/features/sharing/secure-vault.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';

const userId = 'private-sql-owner';
function fixture(path, decorate = value => value) {
  const bridge = createDatabase(path); const database = decorate(bridge.database);
  const descriptor = { kind: 'private-calendar', ownerUserId: userId, filename: privateCalendarDatabaseFilename(userId, true), development: true, database };
  return { ...bridge, database, descriptor, storage: createPrivateCalendarExclusiveStorage(descriptor) };
}
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('private Calendar storage refuses personal or foreign database descriptors before making any table', t => {
  const h = fixture(); t.after(() => h.connection.close());
  for (const patch of [{ kind: 'personal' }, { filename: 'housework-planner.db' }, { ownerUserId: 'another-user' }, { development: false }]) {
    assert.throws(() => createPrivateCalendarExclusiveStorage({ ...h.descriptor, ...patch }), /本人/u);
  }
  assert.equal(h.writes.length, 0);
  assert.deepEqual(h.connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all(), []);
});

test('private Calendar one connection serializes concurrent callbacks and keeps working after a failed callback', async t => {
  const h = fixture(); t.after(() => h.connection.close()); let active = 0; let maximum = 0;
  const values = await Promise.all(Array.from({ length: 30 }, (_, index) => h.storage.exclusive(userId, async () => {
    active++; maximum = Math.max(maximum, active); await sleep(1); active--; return index;
  })));
  assert.equal(maximum, 1); assert.deepEqual(values, Array.from({ length: 30 }, (_, index) => index));
  await assert.rejects(() => h.storage.exclusive(userId, async () => { throw new Error('vault failed'); }), /vault failed/u);
  assert.equal(await h.storage.exclusive(userId, async () => 7), 7);
  const before = h.writes.length; await assert.rejects(() => h.storage.exclusive('another-user', async () => 8), /接続先/u);
  assert.equal(h.writes.length, before);
});

test('private Calendar two SQLite connections cannot overlap vault callbacks while the first awaits native I/O', { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-calendar-lock-')); const path = join(directory, privateCalendarDatabaseFilename(userId, true));
  const a = fixture(path); const b = fixture(path); t.after(() => { a.connection.close(); b.connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const order = []; let enter; const started = new Promise(resolve => { enter = resolve; });
  const first = a.storage.exclusive(userId, async () => { order.push('first-start'); enter(); await sleep(80); order.push('first-end'); return 1; });
  await started; const second = b.storage.exclusive(userId, async () => { order.push('second-start'); await sleep(5); order.push('second-end'); return 2; });
  assert.deepEqual(await Promise.all([first, second]), [1, 2]);
  assert.deepEqual(order, ['first-start', 'first-end', 'second-start', 'second-end']);
});

test('private Calendar independent runtimes share the SQLite lock and cannot generate competing device identities or current keys', { timeout: 10_000 }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'liflow-private-calendar-vault-')); const path = join(directory, privateCalendarDatabaseFilename(userId, true));
  const a = fixture(path); const b = fixture(path); t.after(() => { a.connection.close(); b.connection.close(); rmSync(directory, { recursive: true, force: true }); });
  const values = new Map(); let generations = 0;
  const makeStore = storage => {
    const vault = createSecureVault({ get: async key => values.get(key) ?? null, set: async (key, value) => { values.set(key, value); }, remove: async key => { values.delete(key); } }, crypto.randomBytes);
    return createPrivateCalendarSecretStore({ vault, crypto: { ...crypto, randomBytes: async length => { generations++; return crypto.randomBytes(length); } },
      exclusive: storage.exclusive, assertOwner: expected => { assert.equal(expected, userId); } });
  };
  const left = makeStore(a.storage); const right = makeStore(b.storage);
  const [first, second] = await Promise.all([left.identity(userId), right.identity(userId)]);
  assert.equal(first.deviceId, second.deviceId); assert.equal(generations, 2);
  const root = await createPrivateCalendarRoot(crypto, userId, first); await left.confirmTrust(userId, root, 'firstDeviceSetup');
  const keys = await Promise.all([left.createCurrentKey(userId, root), right.createCurrentKey(userId, root)]);
  assert.equal(generations, 3); assert.ok(keys[0].every((byte, index) => byte === keys[1][index]));
  assert.equal((await right.authority(userId)).digest, root.digest);
});

test('private Calendar retries contention before the vault callback but never replays a callback that already changed an external store', async t => {
  let busyOnce = true; const h = fixture(undefined, database => ({ ...database, async runAsync(sql, ...params) {
    if (busyOnce && sql.startsWith('UPDATE private_calendar_scope')) { busyOnce = false; throw new Error('SQLITE_BUSY'); }
    return database.runAsync(sql, ...params);
  } })); t.after(() => h.connection.close());
  let calls = 0; assert.equal(await h.storage.exclusive(userId, async () => { calls++; return 3; }), 3); assert.equal(calls, 1);
  await assert.rejects(() => h.storage.exclusive(userId, async () => { calls++; throw new Error('SQLITE_BUSY after a durable vault write'); }), /SQLITE_BUSY/u);
  assert.equal(calls, 2, 'the second callback must not be retried');
  assert.equal(await h.storage.exclusive(userId, async () => 4), 4);
});

test('private Calendar exhausted lock contention is bounded and never enters the vault callback', { timeout: 5000 }, async t => {
  const h = fixture(undefined, database => ({ ...database, async runAsync(sql, ...params) {
    if (sql.startsWith('UPDATE private_calendar_scope')) throw new Error('SQLITE_LOCKED'); return database.runAsync(sql, ...params);
  } })); t.after(() => h.connection.close()); let entered = false;
  await assert.rejects(() => h.storage.exclusive(userId, async () => { entered = true; }), /SQLITE_LOCKED/u);
  assert.equal(entered, false);
});

test('private Calendar a persisted foreign owner blocks access without relabeling or replacing that scope', async t => {
  const h = fixture(); t.after(() => h.connection.close()); await h.storage.exclusive(userId, async () => {});
  h.connection.prepare('UPDATE private_calendar_scope SET owner_user_id = ?').run('another-user'); let entered = false;
  await assert.rejects(() => h.storage.exclusive(userId, async () => { entered = true; }), /本人/u);
  assert.equal(entered, false); assert.equal(h.connection.prepare('SELECT owner_user_id FROM private_calendar_scope').get().owner_user_id, 'another-user');
});
