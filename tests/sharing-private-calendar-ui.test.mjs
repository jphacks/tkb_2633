import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { auditPrivateCalendarNative } from '../src/features/sharing/development/private-calendar-audit.ts';
import { createHash } from 'node:crypto';

test('private Calendar development audit exercises the same encryption contracts without accessing accounts and release mode rejects before generating keys', async () => {
  let generated = 0;
  await assert.rejects(() => auditPrivateCalendarNative({ ...crypto, randomBytes: async length => { generated++; return crypto.randomBytes(length); } }, false), /開発/u);
  assert.equal(generated, 0);
  const result = await auditPrivateCalendarNative({ ...crypto, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) }, true);
  assert.equal(result.checks.length, 12); assert.equal(result.intervalCount, 20_000); assert.ok(result.chunkCount > 10);
  assert.deepEqual(Object.keys(result).sort(), ['checks', 'chunkCount', 'elapsedMs', 'intervalCount', 'timings']);
});
for (const [platform, releaseTestName] of [
  ['ios', 'ios private Calendar Native audit has no action in release builds'],
  ['android', 'android private Calendar Native audit has no action in release builds'],
]) {
  test(`${platform} private Calendar Native audit is explicit, single-flight and hides all secret material from the screen`, async () => {
    const before = globalThis.__DEV__; globalThis.__DEV__ = true;
    const cleanup = []; let calls = 0; let release;
    const pending = new Promise(resolve => { release = resolve; });
    try {
      const screen = screenHarness('src/features/sharing/development/private-calendar-audit-screen.tsx', {
        exportName: 'PrivateCalendarAuditScreen', platform,
        effect: callback => { const dispose = callback(); if (dispose) cleanup.push(dispose); },
        mocks: { '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: crypto },
          './private-calendar-audit': { auditPrivateCalendarNative: async (...args) => { calls++; assert.equal(args[1], true); return pending; } } },
      });
      assert.equal(calls, 0); assert.match(screen.text(), /クラウドへ送信しません/u);
      const button = screen.button('Native暗号を検査する');
      assert.ok(button); button.props.onPress(); button.props.onPress(); await screen.flush(); assert.equal(calls, 1);
      release({ checks: ['Native認証付き暗号'], intervalCount: 20_000, chunkCount: 22, elapsedMs: 40,
        timings: { preparationMs: 10, sealMs: 10, openMs: 10, checksMs: 10 } }); await screen.flush();
      assert.match(screen.text(), /本人用Calendar暗号 PASS：1件/u); assert.match(screen.text(), /20,000区間/u);
      assert.equal(screen.text().includes('encryptedPayload'), false); assert.equal(screen.text().includes('accountKey'), false);
    } finally { cleanup.forEach(dispose => dispose()); globalThis.__DEV__ = before; }
  });
  test(releaseTestName, async () => {
    const before = globalThis.__DEV__; globalThis.__DEV__ = false; let calls = 0;
    try {
      const screen = screenHarness('src/features/sharing/development/private-calendar-audit-screen.tsx', { exportName: 'PrivateCalendarAuditScreen', platform,
        mocks: { '../../../platform/sharing/native-private-calendar-crypto': { nativePrivateCalendarCrypto: crypto }, './private-calendar-audit': { auditPrivateCalendarNative: async () => { calls++; } } } });
      assert.match(screen.text(), /開発ビルドだけ/u);
      assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button'), false); assert.equal(calls, 0);
    } finally { globalThis.__DEV__ = before; }
  });
}
