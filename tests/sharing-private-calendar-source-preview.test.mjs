import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { screenHarness } from './helpers/screen-harness.mjs';
import { createPrivateCalendarSourceStorage } from '../src/platform/storage/private-calendar-source.ts';
import { createPrivateCalendarDeviceSession } from '../src/features/sharing/private-calendar/device-session.ts';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { createPrivateCalendarSourceController } from '../src/features/sharing/private-calendar/source-controller.ts';
const { createPrivateCalendarRuntime } = await import('../src/features/sharing/private-calendar/runtime.ts');

for (const platform of ['ios', 'android']) {
  test(`${platform} private source physical QA uses a separate protected profile and real runtime without Google login personal data or existing pairing changes`, async t => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = true; t.after(() => { globalThis.__DEV__ = previous; });
    const userId = `development-calendar-native-source-${platform}-v1`; const f = privateCalendarSetupFixture(t, { userId }); const h = privateCalendarMemoryCloud(); let opened = 0; let closed = 0;
    const source = createPrivateCalendarSourceStorage({ ownerUserId: userId, readProtected: f.readProtected, exclusive: f.exclusive, vault: f.vault, assertOwner: uid => assert.equal(uid, userId) });
    const module = loadNativeModule('src/platform/sharing/private-calendar-source-preview.ts', {
      './private-calendar-root-audit': { createPrivateCalendarRootAuditContext: async (os, _host, _port, scenario) => { assert.equal(os, platform); assert.equal(scenario, 'source'); opened++;
        return { userId, secrets: f.secrets, cloud: h.cloud, intents: f.roots, crypto: f.gateway, close: async () => { closed++; } }; } },
      './private-calendar-secrets': { developmentPrivateCalendarAuthorityIntents: () => f.changes, developmentPrivateCalendarCache: () => f.cache,
        developmentPrivateCalendarSource: () => source, developmentPrivateCalendarKeyOutbox: () => f.keyOutbox, developmentPrivateCalendarPairing: () => f.pairing },
      '../../features/sharing/private-calendar/device-session': { createPrivateCalendarDeviceSession }, '../../features/sharing/private-calendar/authority-sync': { createPrivateCalendarAuthoritySync },
      '../../features/sharing/private-calendar/source-controller': { createPrivateCalendarSourceController }, '../../features/sharing/private-calendar/runtime': { createPrivateCalendarRuntime },
    });
    globalThis.__DEV__ = false; await assert.rejects(() => module.createPrivateCalendarSourcePreview(platform, '127.0.0.1', '8185'), /開発/u); assert.equal(opened, 0);
    globalThis.__DEV__ = true; const preview = await module.createPrivateCalendarSourcePreview(platform, '127.0.0.1', '8185');
    assert.equal((await preview.runtime.readSettings()).device.phase, 'unconfigured'); assert.equal(f.state.generations, 0); await preview.initialize();
    const before = await preview.runtime.readSettings(); const account = await preview.runtime.checkGoogleAccount(); await preview.runtime.connectCurrentSource(account.subject, before.device.authorityDigest);
    assert.equal((await preview.runtime.refreshData()).kind, 'published'); assert.deepEqual(await preview.verify(), { revision: 2, queries: 1 });
    const keys = f.state.generations; const reopened = await module.createPrivateCalendarSourcePreview(platform, '127.0.0.1', '8185');
    assert.deepEqual(await reopened.verify(), { revision: 2, queries: 0 }); assert.equal(f.state.generations, keys); assert.equal(h.history.length, 2);
    assert.deepEqual(await reopened.verifyAutomatic(), { requests: 100, queries: 0 }); assert.equal(h.history.length, 2);
    await preview.close(); await reopened.close(); assert.equal(closed, 2); globalThis.__DEV__ = false; await assert.rejects(() => reopened.runtime.readSettings(), /変わりました/u);
  });
}

test('private source preview route is absent in release and an abandoned load cannot initialize an audit profile', async () => {
  const previous = globalThis.__DEV__; let opens = 0;
  try {
    globalThis.__DEV__ = false; const screen = screenHarness('src/app/development/private-calendar-source-preview.tsx', { mocks: {
      '../../platform/sharing/private-calendar-source-preview': { createPrivateCalendarSourcePreview: async () => { opens++; throw new Error('must not open'); } },
    } });
    assert.match(screen.text(), /開発ビルド専用/u); assert.equal(opens, 0); assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button'), false);
  } finally { globalThis.__DEV__ = previous; }
});
