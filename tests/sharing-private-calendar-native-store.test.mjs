import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import * as vault from '../src/features/sharing/secure-vault.ts';
import * as secrets from '../src/features/sharing/private-calendar/secret-store.ts';
import * as storage from '../src/platform/storage/private-calendar-store.ts';
import { privateCalendarDatabaseFilename } from '../src/features/sharing/private-calendar/database-name.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createHash } from 'node:crypto';
import { auditPrivateCalendarStoredState } from '../src/features/sharing/development/private-calendar-store-audit.ts';

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
    assert.equal(f.calls.length, 0); assert.equal(f.opens.length, 0); assert.equal(f.authReads(), 0);
    globalThis.__DEV__ = true; const qa = f.module.developmentPrivateCalendarSecrets();
    await assert.rejects(() => qa.identity('private-owner'), /アカウント/u); assert.equal(f.opens.length, 0);
    await qa.identity('development-calendar-private-store'); assert.equal(f.authReads(), 0); assert.equal(f.opens.length, 1);
    assert.equal(f.opens[0].development, true);
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
