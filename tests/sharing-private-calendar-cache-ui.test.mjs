import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { PRIVATE_CALENDAR_STORE_QA_USER_ID } from '../src/features/sharing/development/private-calendar-store-audit.ts';

for (const platform of ['ios', 'android']) {
  test(`${platform} private ciphertext cache audit starts once from its explicit button and exposes only synthetic public proof`, async () => {
    const before = globalThis.__DEV__; globalThis.__DEV__ = true; let starts = 0; let opens = 0; let resolve; const cleanups = [];
    const gate = new Promise(done => { resolve = done; });
    try {
      const screen = screenHarness('src/features/sharing/development/private-calendar-store-audit-screen.tsx', { exportName: 'PrivateCalendarCacheAuditScreen', platform,
        effect: callback => { const cleanup = callback(); if (cleanup) cleanups.push(cleanup); },
        mocks: {
          '../../../platform/sharing/private-calendar-secrets': { developmentPrivateCalendarSecrets: () => { opens++; return {}; },
            developmentPrivateCalendarCache: uid => { assert.equal(uid, PRIVATE_CALENDAR_STORE_QA_USER_ID); opens++; return {}; } },
          '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: {} },
          './private-calendar-store-audit': { PRIVATE_CALENDAR_STORE_QA_USER_ID, auditPrivateCalendarStoredState: () => { throw new Error('cache mode required'); } },
          './private-calendar-cache-audit': { auditPrivateCalendarCacheState: async options => { starts++; assert.equal(options.development, true); return gate; } },
        } });
      assert.equal(opens, 0); const run = screen.button('本人キャッシュを検査する'); run.props.onPress(); run.props.onPress(); await screen.flush();
      assert.equal(starts, 1); assert.equal(opens, 2);
      resolve({ mode: 'restored', deviceId: 'public-qa-device', authorityDigest: 'public-authority-digest', storageProof: 'synthetic-qa-proof',
        sequence: 2, chunkCount: 22, checks: Array.from({ length: 8 }, (_, index) => `検査${index + 1}`) }); await screen.flush();
      assert.match(screen.text(), /本人キャッシュの検査 PASS：8件/u); assert.match(screen.text(), /キャッシュ連番：2・分割：22/u);
      for (const text of ['signingSecretKey', 'agreementSecretKey', 'accountKey', 'intervals']) assert.equal(screen.text().includes(text), false);
    } finally { cleanups.forEach(cleanup => cleanup()); globalThis.__DEV__ = before; }
  });
  test(`${platform} private ciphertext cache screen refuses native access in release mode`, () => {
    const before = globalThis.__DEV__; globalThis.__DEV__ = false; let touched = false;
    try {
      const forbidden = () => { touched = true; throw new Error('release must not call this'); };
      const screen = screenHarness('src/features/sharing/development/private-calendar-store-audit-screen.tsx', { exportName: 'PrivateCalendarCacheAuditScreen', platform,
        mocks: { '../../../platform/sharing/private-calendar-secrets': { developmentPrivateCalendarSecrets: forbidden, developmentPrivateCalendarCache: forbidden },
          '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: {} },
          './private-calendar-store-audit': { PRIVATE_CALENDAR_STORE_QA_USER_ID, auditPrivateCalendarStoredState: forbidden },
          './private-calendar-cache-audit': { auditPrivateCalendarCacheState: forbidden } } });
      assert.match(screen.text(), /開発ビルドだけ/u); assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button'), false); assert.equal(touched, false);
    } finally { globalThis.__DEV__ = before; }
  });
}
