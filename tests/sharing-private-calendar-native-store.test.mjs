import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import * as vault from '../src/features/sharing/secure-vault.ts';
import * as secrets from '../src/features/sharing/private-calendar/secret-store.ts';
import * as storage from '../src/platform/storage/private-calendar-store.ts';
import * as cacheStorage from '../src/platform/storage/private-calendar-cache.ts';
import * as rootSetupStorage from '../src/platform/storage/private-calendar-root-setup.ts';
import { privateCalendarDatabaseFilename } from '../src/features/sharing/private-calendar/database-name.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createHash } from 'node:crypto';
import { auditPrivateCalendarStoredState } from '../src/features/sharing/development/private-calendar-store-audit.ts';
import { createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { sealPrivateCalendarCache } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { auditPrivateCalendarCacheState } from '../src/features/sharing/development/private-calendar-cache-audit.ts';
import { PRIVATE_CALENDAR_STORE_QA_USER_ID } from '../src/features/sharing/development/private-calendar-store-audit.ts';
import { createPrivateCalendarFirstDeviceSetup } from '../src/features/sharing/private-calendar/first-device-setup.ts';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';

function fixture(values = new Map([['jp.jphacks.tkb2633.sharing:original', 'preserved']])) {
  const calls = []; const opens = []; const databases = [];
  let authReads = 0; let currentUser = null;
  const module = loadNativeModule('src/platform/sharing/private-calendar-secrets.ts', {
    'expo-secure-store': { AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'device-only-after-unlock',
      getItemAsync: async (key, options) => { calls.push({ kind: 'get', options }); return values.get(`${options.keychainService}:${key}`) ?? null; },
      setItemAsync: async (key, value, options) => { calls.push({ kind: 'set', options }); values.set(`${options.keychainService}:${key}`, value); },
      deleteItemAsync: async (key, options) => { calls.push({ kind: 'remove', options }); values.delete(`${options.keychainService}:${key}`); } },
    '../../features/sharing/secure-vault.ts': vault,
    '../../features/sharing/private-calendar/secret-store.ts': secrets,
    '../storage/private-calendar-store.ts': storage,
    '../storage/private-calendar-cache.ts': cacheStorage,
    '../storage/private-calendar-root-setup.ts': rootSetupStorage,
    './firebase-services.ts': { getSharingServices: () => { authReads++; return { auth: { currentUser } }; } },
    './native-private-calendar-crypto': { nativePrivateCalendarCrypto: crypto },
    './database-location': { openPrivateCalendarDatabase: async (ownerUserId, development) => {
      const h = createDatabase(); databases.push(h); const descriptor = { kind: 'private-calendar', ownerUserId, development,
        filename: privateCalendarDatabaseFilename(ownerUserId, development), database: h.database }; opens.push(descriptor); return descriptor;
    } },
  });
  return { module, values, calls, opens, authReads: () => authReads, auth: uid => { currentUser = uid ? { uid } : null; }, close: () => databases.forEach(h => h.connection.close()) };
}

test('private Calendar Native secret adapter stays lazy, uses its own Keychain service and only opens the authenticated owner database', async t => {
  const f = fixture(); t.after(f.close); assert.equal(f.authReads(), 0); assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0);
  await assert.rejects(() => f.module.nativePrivateCalendarSecrets.identity('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
  f.auth('private-owner'); const identity = await f.module.nativePrivateCalendarSecrets.identity('private-owner');
  assert.equal((await f.module.nativePrivateCalendarSecrets.identity('private-owner')).deviceId, identity.deviceId); assert.equal(f.opens.length, 1);
  assert.equal(f.opens[0].development, false); assert.equal(f.opens[0].ownerUserId, 'private-owner');
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar' && call.options.keychainAccessible === 'device-only-after-unlock'));
  const count = f.calls.length; await assert.rejects(() => f.module.nativePrivateCalendarSecrets.identity('another-owner'), /アカウント/u);
  assert.equal(f.calls.length, count); assert.equal(f.opens.length, 1); assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});

test('private Calendar development key storage is release-blocked and uses a separate QA service without initializing Firebase', async t => {
  const before = globalThis.__DEV__; const f = fixture(); t.after(f.close);
  try {
    globalThis.__DEV__ = false; assert.throws(() => f.module.developmentPrivateCalendarSecrets(), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarCache('development-calendar-private-store'), /開発/u);
    assert.throws(() => f.module.developmentPrivateCalendarRootSetup('development-calendar-private-store'), /開発/u);
    assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0); assert.equal(f.authReads(), 0);
    globalThis.__DEV__ = true; const qa = f.module.developmentPrivateCalendarSecrets();
    await assert.rejects(() => qa.identity('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
    await qa.identity('development-calendar-private-store'); assert.equal(f.authReads(), 0); assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].development, true);
    const qaCache = f.module.developmentPrivateCalendarCache('development-calendar-private-store');
    assert.equal(typeof qaCache.save, 'function'); assert.equal(f.authReads(), 0);
    assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar.qa'));
    assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar persisted Native audit recovers the same synthetic keys and public proof in a reconstructed runtime without touching an account', async t => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true;
  const a = fixture(); t.after(a.close);
  const accelerated = { ...crypto, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) };
  try {
    const first = await auditPrivateCalendarStoredState({ development: true, crypto: accelerated, store: a.module.developmentPrivateCalendarSecrets() });
    const b = fixture(a.values); t.after(b.close);
    const second = await auditPrivateCalendarStoredState({ development: true, crypto: accelerated, store: b.module.developmentPrivateCalendarSecrets() });
    assert.equal(first.mode, 'created'); assert.equal(second.mode, 'restored'); assert.equal(second.checks.length, 4);
    assert.equal(second.deviceId, first.deviceId); assert.equal(second.authorityDigest, first.authorityDigest); assert.equal(second.storageProof, first.storageProof);
    assert.deepEqual(Object.keys(second).sort(), ['authorityDigest', 'checks', 'deviceId', 'mode', 'storageProof']);
    assert.equal(a.authReads(), 0); assert.equal(b.authReads(), 0); assert.equal(a.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar persisted audit rejects release execution before accessing any key or database', async () => {
  let touched = false; const store = new Proxy({}, { get() { touched = true; throw new Error('no key access'); } });
  await assert.rejects(() => auditPrivateCalendarStoredState({ development: false, crypto, store }), /開発/u); assert.equal(touched, false);
});

test('private Calendar Native cache uses the same protected vault and transaction lock and never writes plaintext or bypasses missing trust', async t => {
  const f = fixture(); t.after(f.close); f.auth('private-owner');
  const store = f.module.nativePrivateCalendarSecrets; const identity = await store.identity('private-owner');
  const root = await createPrivateCalendarRoot(crypto, 'private-owner', identity);
  const ledger = f.module.nativePrivateCalendarCache('private-owner');
  const cache = { ownerUserId: 'private-owner', accountGeneration: root.signed.body.accountGeneration, mainDeviceId: identity.deviceId,
    mainRevision: 1, calendarBinding: 'native-private-binding', timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00Z',
    coverage: { start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z' }, intervals: [] };
  const temporaryKey = new Uint8Array(32).fill(7);
  const untrusted = await sealPrivateCalendarCache(crypto, { cache, authority: root, calendarBinding: cache.calendarBinding, accountKey: temporaryKey, mainDevice: identity, sequence: 1 });
  const input = { authority: root, calendarBinding: cache.calendarBinding, accountKey: temporaryKey };
  await assert.rejects(() => ledger.save(untrusted, { ...input, origin: 'local' }), /信頼/u);
  await store.confirmTrust('private-owner', root, 'firstDeviceSetup'); const key = await store.createCurrentKey('private-owner', root);
  const encrypted = await sealPrivateCalendarCache(crypto, { cache, authority: root, calendarBinding: cache.calendarBinding, accountKey: key, mainDevice: identity, sequence: 1 });
  await ledger.save(encrypted, { ...input, accountKey: key, origin: 'local' });
  assert.equal((await ledger.read({ ...input, accountKey: key })).calendarBinding, cache.calendarBinding);
  assert.deepEqual((await ledger.pending(root, 1)).encrypted, encrypted); assert.equal(f.opens.length, 1);
  const before = f.calls.length; f.auth('another-owner');
  await assert.rejects(() => ledger.read({ ...input, accountKey: key }), /アカウント/u);
  assert.throws(() => f.module.nativePrivateCalendarCache('private-owner'), /アカウント/u);
  assert.equal(f.calls.length, before); assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved'); key.fill(0);
});

test('private Calendar Native ciphertext audit persists twenty thousand intervals and resumes the exact previous snapshot without accessing an account', async t => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true; const f = fixture(); t.after(f.close);
  try {
    const accelerated = { ...crypto, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) };
    const store = f.module.developmentPrivateCalendarSecrets(); const cache = f.module.developmentPrivateCalendarCache(PRIVATE_CALENDAR_STORE_QA_USER_ID);
    const options = { development: true, crypto: accelerated, store, cache };
    const first = await auditPrivateCalendarCacheState(options); const restored = await auditPrivateCalendarCacheState(options);
    assert.equal(first.checks.length, 8); assert.equal(restored.checks.length, 8);
    assert.equal(first.mode, 'created'); assert.equal(restored.mode, 'restored'); assert.equal(first.sequence, 1); assert.equal(restored.sequence, 2);
    assert.equal(first.chunkCount, 22); assert.equal(restored.chunkCount, 22); assert.equal(restored.storageProof, first.storageProof);
    assert.equal(f.opens.length, 1); assert.equal(f.authReads(), 0);
    for (const text of ['signingSecretKey', 'agreementSecretKey', 'intervals', 'development-private-calendar-cache-v1']) assert.equal(JSON.stringify(restored).includes(text), false);
    const unopened = new Proxy({}, { get() { throw new Error('must not access any store'); } });
    await assert.rejects(() => auditPrivateCalendarCacheState({ ...options, development: false, store: unopened, cache: unopened }), /開発/u);
    assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar Native first-device setup shares its own protected vault and SQL connection and requires the authenticated owner', async t => {
  const f = fixture(); t.after(f.close);
  assert.throws(() => f.module.nativePrivateCalendarRootSetup('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0); assert.equal(f.calls.length, 0);
  f.auth('private-owner'); const roots = f.module.nativePrivateCalendarRootSetup('private-owner'); const secrets = f.module.nativePrivateCalendarSecrets;
  let received; const cloud = { async createRoot(root) { received = root; assert.equal(await secrets.authority('private-owner'), null); return { head: privateCalendarCloudFields(root) }; } };
  const setup = createPrivateCalendarFirstDeviceSetup({ userId: 'private-owner', secrets, intents: roots, cloud });
  const result = await setup.prepareAndResume(); assert.equal(result.rootDigest, received.digest); assert.equal((await roots.read()).status, 'ready');
  assert.equal(f.opens.length, 1); assert.equal(f.opens[0].development, false);
  assert.ok(f.calls.every(call => call.options.keychainService === 'jp.jphacks.tkb2633.private-calendar'));
  const count = f.calls.length; f.auth('another-owner'); await assert.rejects(() => setup.resume(), /アカウント/u); assert.equal(f.calls.length, count);
  assert.equal(f.values.get('jp.jphacks.tkb2633.sharing:original'), 'preserved');
});
