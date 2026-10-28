import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bytesToHex } from '@noble/hashes/utils.js';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { privateCalendarCloudFields } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { auditPrivateCalendarRootSetup } from '../src/features/sharing/development/private-calendar-root-audit.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';

test('private Calendar root audit preserves its prepared root across reconstruction and retains one key through repeated resume', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'liflow-native-root-qa-')); t.after(() => rmSync(dir, { force: true, recursive: true }));
  const options = { userId: 'development-calendar-native-root-test-v1', path: join(dir, 'root.db') };
  const f = privateCalendarSetupFixture(t, options); let head = null; let denied = 0;
  const cloud = { async createRoot(root) { if (head) assert.equal(root.digest, head.rootDigest); head ??= privateCalendarCloudFields(root); return { head }; }, async readHead() { return head; } };
  const port = h => ({ userId: h.userId, secrets: h.secrets, intents: h.roots, crypto: { ...crypto, digestSha256: async key => new Uint8Array(createHash('sha256').update(key).digest()) }, cloud,
    async assertOtherUserDenied() { denied++; } });
  const prepared = await auditPrivateCalendarRootSetup(true, 'prepare', port(f));
  assert.equal(prepared.phase, 'prepared'); assert.equal(prepared.checks.length, 4); assert.equal(prepared.keyProof, null);
  assert.equal((await f.readProtected()).authority, null); assert.equal((await f.readProtected()).hasStoredKeys, false);
  const restarted = privateCalendarSetupFixture(t, { ...options, values: f.values, state: f.state });
  const ready = await auditPrivateCalendarRootSetup(true, 'resume', port(restarted));
  const again = await auditPrivateCalendarRootSetup(true, 'resume', port(restarted));
  assert.equal(ready.rootDigest, prepared.rootDigest); assert.equal(ready.deviceId, prepared.deviceId); assert.equal(ready.phase, 'ready');
  assert.equal(ready.checks.length, 6); assert.equal(ready.keyProof.length, 64); assert.deepEqual(again, ready); assert.equal(denied, 3);
  await assert.rejects(() => auditPrivateCalendarRootSetup(true, 'prepare', port(restarted)), /初期化は行いません/u);
  assert.equal((await restarted.roots.read()).status, 'ready');
});

test('private Calendar root audit denies release and non-QA owners before any storage access', async () => {
  const untouched = new Proxy({}, { get() { throw new Error('must not touch'); } });
  await assert.rejects(() => auditPrivateCalendarRootSetup(false, 'prepare', untouched), /開発/u);
  await assert.rejects(() => auditPrivateCalendarRootSetup(true, 'prepare', { userId: 'real-owner' }), /検査専用/u);
});

function nativeFixture() {
  const calls = []; let denied = true;
  const forbidden = () => { throw new Error('production Firebase Auth must not initialize'); };
  const module = loadNativeModule('src/platform/sharing/private-calendar-root-audit.ts', {
    'firebase/app': { initializeApp: (config, name) => { calls.push(['app', config, name]); return { name }; }, deleteApp: async app => { calls.push(['delete', app.name]); } },
    'firebase/firestore': { initializeFirestore: (app, config) => { calls.push(['firestore', config]); return { app }; }, connectFirestoreEmulator: (db, host, port, options) => { calls.push(['emulator', host, port, options]); },
      terminate: async () => { calls.push(['terminate']); }, doc: (...args) => args, getDocFromServer: async () => { if (denied) throw { code: 'permission-denied' }; return {}; } },
    '@noble/hashes/utils.js': { bytesToHex },
    './private-calendar-secrets': { developmentPrivateCalendarSecrets: () => { calls.push(['secrets']); return {}; }, developmentPrivateCalendarRootSetup: uid => { calls.push(['intents', uid]); return {}; } },
    './native-private-calendar-crypto': { nativePrivateCalendarCrypto: { randomBytes: async n => new Uint8Array(n).fill(7) } },
    './private-calendar-cloud.ts': { createPrivateCalendarCloud: (db, uid, getUser) => { assert.equal(uid, getUser()); calls.push(['cloud', uid]); return {}; } },
    './firebase-services.ts': { getSharingServices: forbidden },
  });
  return { module, calls, deny: value => { denied = value; } };
}

test('private Calendar root QA network provider is lazy and restricted to a separate demo project and private numeric endpoints', async () => {
  const before = globalThis.__DEV__; const f = nativeFixture(); assert.equal(f.calls.length, 0);
  try {
    globalThis.__DEV__ = false; await assert.rejects(() => f.module.createPrivateCalendarRootAuditContext('ios', '127.0.0.1', 8185), /開発/u); assert.equal(f.calls.length, 0);
    globalThis.__DEV__ = true;
    for (const host of ['8.8.8.8', 'firebase.googleapis.com', '127.0.0.256', '010.0.0.1', '192.168.1.1.evil', '0.0.0.0', ['127.0.0.1']]) await assert.rejects(() => f.module.createPrivateCalendarRootAuditContext('ios', host, 8185));
    await assert.rejects(() => f.module.createPrivateCalendarRootAuditContext('web', '127.0.0.1', 8185));
    await assert.rejects(() => f.module.createPrivateCalendarRootAuditContext('android', '127.0.0.1', 443)); assert.equal(f.calls.length, 0);
    const port = await f.module.createPrivateCalendarRootAuditContext('android', '127.0.0.1', 8185);
    assert.ok(f.calls.filter(call => call[0] === 'app').every(call => call[1].projectId === 'demo-liflow-private-native'));
    assert.equal(f.calls.filter(call => call[0] === 'emulator').length, 2); assert.match(port.userId, /^development-calendar-native-root-android-/u);
    await port.assertOtherUserDenied(); f.deny(false); await assert.rejects(port.assertOtherUserDenied, /Rules/u);
    await port.close(); assert.equal(f.calls.filter(call => call[0] === 'delete').length, 2); assert.equal(f.calls.filter(call => call[0] === 'terminate').length, 2);
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar pairing QA uses one fixed synthetic UID across both OS and never reuses the original bootstrap scenario', async () => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true;
  try {
    for (const os of ['ios', 'android']) {
      const f = nativeFixture(); const shared = await f.module.createPrivateCalendarRootAuditContext(os, '127.0.0.1', 8185, 'pairing');
      assert.equal(shared.userId, 'development-calendar-native-pairing-e2e-v1'); await shared.close();
      await assert.rejects(() => f.module.createPrivateCalendarRootAuditContext(os, '127.0.0.1', 8185, 'unknown'), /保存先/u);
    }
  } finally { globalThis.__DEV__ = before; }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} private Calendar initial-setup QA has explicit separate stages and no release side effects`, async () => {
    const before = globalThis.__DEV__; const cleanups = []; let opened = 0; let closed = 0; let release; const actions = [];
    const gate = new Promise(resolve => { release = resolve; });
    const mocks = { '../../../platform/sharing/private-calendar-root-audit': { createPrivateCalendarRootAuditContext: async os => { assert.equal(os, platform); opened++; return { close: async () => { closed++; } }; } },
      './private-calendar-root-audit': { auditPrivateCalendarRootSetup: async (dev, action) => { assert.equal(dev, true); actions.push(action); return gate; } } };
    try {
      globalThis.__DEV__ = false;
      const locked = screenHarness('src/features/sharing/development/private-calendar-root-audit-screen.tsx', { exportName: 'PrivateCalendarRootAuditScreen', platform, mocks });
      assert.match(locked.text(), /開発ビルドだけ/u); assert.equal(locked.nodes().filter(n => n.props.accessibilityRole === 'button').length, 0); assert.equal(opened, 0);
      globalThis.__DEV__ = true;
      const screen = screenHarness('src/features/sharing/development/private-calendar-root-audit-screen.tsx', { exportName: 'PrivateCalendarRootAuditScreen', platform, mocks,
        effect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); } });
      const button = screen.button('中断用の初回設定を準備する'); button.props.onPress(); button.props.onPress(); await screen.flush(); assert.equal(opened, 1); assert.deepEqual(actions, ['prepare']);
      release({ phase: 'prepared', deviceId: 'public-device', rootDigest: 'public-root', keyProof: null, checks: ['one', 'two', 'three', 'four'] }); await screen.flush();
      assert.match(screen.text(), /中断前の準備完了：4件/u); assert.equal(screen.text().includes('PASS'), false); assert.equal(closed, 1);
      await screen.press('保存した初回設定を再開する'); assert.deepEqual(actions, ['prepare', 'resume']); assert.equal(closed, 2);
    } finally { cleanups.forEach(fn => fn()); globalThis.__DEV__ = before; }
  });
}
