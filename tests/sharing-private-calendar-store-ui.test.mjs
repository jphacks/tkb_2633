import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';

test('private Calendar persisted-key screen cannot open its Native store in a release build', () => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = false; let opened = 0;
  try {
    const screen = screenHarness('src/features/sharing/development/private-calendar-store-audit-screen.tsx', { exportName: 'PrivateCalendarStoreAuditScreen',
      mocks: { '../../../platform/sharing/private-calendar-secrets': { developmentPrivateCalendarSecrets: () => { opened++; throw new Error('no Native access'); } },
        '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: {} }, './private-calendar-store-audit': { auditPrivateCalendarStoredState: () => { throw new Error('no audit'); } } } });
    assert.match(screen.text(), /開発ビルドだけ/u); assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button'), false); assert.equal(opened, 0);
  } finally { globalThis.__DEV__ = before; }
});

test('private Calendar persisted-key screen starts one explicit audit and displays only the synthetic public proof', async () => {
  const before = globalThis.__DEV__; globalThis.__DEV__ = true; let opened = 0; let started = 0; let release; const cleanups = [];
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const screen = screenHarness('src/features/sharing/development/private-calendar-store-audit-screen.tsx', { exportName: 'PrivateCalendarStoreAuditScreen',
      effect: callback => { const dispose = callback(); if (dispose) cleanups.push(dispose); },
      mocks: { '../../../platform/sharing/private-calendar-secrets': { developmentPrivateCalendarSecrets: () => { opened++; return {}; } },
        '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: {} },
        './private-calendar-store-audit': { auditPrivateCalendarStoredState: async options => { started++; assert.equal(options.development, true); return gate; } } } });
    assert.equal(opened, 0); const button = screen.button('本人保存を検査する'); button.props.onPress(); button.props.onPress(); await screen.flush();
    assert.equal(opened, 1); assert.equal(started, 1);
    release({ mode: 'restored', deviceId: 'public-device-proof', authorityDigest: 'public-authority-proof', storageProof: 'public-storage-proof', checks: ['署名を確認'] }); await screen.flush();
    assert.match(screen.text(), /本人保存の検査 PASS：1件/u); assert.match(screen.text(), /保存済みの検査用データを復元/u);
    assert.equal(screen.text().includes('signingSecretKey'), false); assert.equal(screen.text().includes('agreementSecretKey'), false);
    assert.equal(screen.nodes().filter(node => node.props.testID?.startsWith('private-calendar-store-')).length, 3);
  } finally { cleanups.forEach(dispose => dispose()); globalThis.__DEV__ = before; }
});
