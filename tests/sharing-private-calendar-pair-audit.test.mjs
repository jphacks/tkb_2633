import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { privateCalendarSetupFixture } from './helpers/private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './helpers/private-calendar-cloud.mjs';
import { createPrivateCalendarAuthoritySync } from '../src/features/sharing/private-calendar/authority-sync.ts';
import { createPrivateCalendarKeyDelivery } from '../src/features/sharing/private-calendar/key-delivery.ts';
import { createPrivateCalendarPairingController } from '../src/features/sharing/private-calendar/pairing-controller.ts';
import { auditPrivateCalendarPair, PRIVATE_CALENDAR_PAIR_QA_STEPS } from '../src/features/sharing/development/private-calendar-pair-audit.ts';
import { screenHarness } from './helpers/screen-harness.mjs';

function context(t, cloud) {
  const f = privateCalendarSetupFixture(t, { userId: 'development-calendar-native-pairing-e2e-v1' }); const { userId, secrets } = f;
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets, intents: f.changes, cloud });
  const delivery = createPrivateCalendarKeyDelivery({ userId, secrets, outbox: f.keyOutbox, cloud });
  const pair = createPrivateCalendarPairingController({ userId, secrets, candidates: f.pairing, intents: f.changes, authoritySync, delivery, cloud });
  return { userId, secrets, intents: f.roots, authoritySync, delivery, pair, outbox: f.keyOutbox, cache: f.cache, cloud,
    crypto: { ...f.gateway, digestSha256: async bytes => new Uint8Array(createHash('sha256').update(bytes).digest()) },
    async assertOtherUserDenied() {}, async close() {} };
}

test('private Calendar two-device QA drives actual SQLite and crypto through pairing, new-main publication without a local cursor, revocation and renewed approval', async t => {
  const { cloud } = privateCalendarMemoryCloud(); const left = context(t, cloud); const right = context(t, cloud);
  const run = (ctx, step, input = {}) => auditPrivateCalendarPair(true, step, input, ctx);
  const source = await run(left, 'reference'); const request = await run(right, 'request', { reference: source.reference });
  const approved = await run(left, 'approve', { request: request.request }); const joined = await run(right, 'join');
  assert.equal(joined.keyProof, approved.keyProof); assert.equal(joined.rootDigest, source.rootDigest);
  const first = await run(left, 'publish'); assert.equal(first.sequence, 1); assert.equal(first.intervalCount, 20000);
  const changed = await run(left, 'main', { deviceId: joined.deviceId }); assert.equal(changed.mainDeviceId, joined.deviceId);
  // The new main never received the previous cache; its counter must come from the server as well as local SQL.
  const published = await run(right, 'publish'); assert.equal(published.sequence, 2); assert.equal(published.intervalCount, 20000); assert.equal(published.chunkCount, 22);
  const received = await run(left, 'receive'); assert.equal(received.cacheProof, published.cacheProof); assert.equal(received.keyProof, joined.keyProof); assert.equal(received.intervalCount, 20000);
  assert.equal((await run(left, 'receive')).restoredBeforeFetch, true);
  const removed = await run(left, 'revoke', { deviceId: joined.deviceId }); assert.notEqual(removed.keyProof, joined.keyProof);
  const revoked = await run(right, 'revoked'); assert.equal(revoked.keyProof, null); assert.equal(revoked.checks.length, 3);
  const fresh = await run(left, 'reference'); const renewed = await run(right, 'request', { reference: fresh.reference });
  assert.equal(renewed.deviceId, joined.deviceId); assert.notEqual(renewed.request, request.request);
  await run(left, 'approve', { request: renewed.request }); const restored = await run(right, 'join'); assert.equal(restored.keyProof, removed.keyProof); assert.equal(restored.rootDigest, source.rootDigest);
});

test('private Calendar two-device audit refuses release and non-QA accounts before any protected or network access', async () => {
  const forbidden = new Proxy({}, { get() { throw new Error('no access'); } });
  await assert.rejects(() => auditPrivateCalendarPair(false, 'reference', {}, forbidden), /開発/u);
  await assert.rejects(() => auditPrivateCalendarPair(true, 'reference', {}, { userId: 'actual-person' }), /検査専用/u);
});

for (const platform of ['ios', 'android']) {
  test(`${platform} two-device QA route starts only one explicit action, preserves its public result and blocks release initialization`, async () => {
    const before = globalThis.__DEV__; let opened = 0; let closed = 0; let invoked = 0; let release; const cleanups = [];
    const gate = new Promise(resolve => { release = resolve; });
    const mocks = { '../../../platform/sharing/private-calendar-pair-audit': { createPrivateCalendarPairAuditContext: async os => { assert.equal(os, platform); opened++; return { close: async () => { closed++; } }; } },
      './private-calendar-pair-audit': { PRIVATE_CALENDAR_PAIR_QA_STEPS, auditPrivateCalendarPair: async (dev, step) => { assert.equal(dev, true); assert.equal(step, 'reference'); invoked++; return gate; } } };
    const options = { platform, mocks, effect: fn => { const dispose = fn(); if (dispose) cleanups.push(dispose); } };
    try {
      globalThis.__DEV__ = false; const releaseScreen = screenHarness('src/app/development/private-calendar-pair-preview.tsx', options);
      assert.equal(releaseScreen.nodes().filter(n => n.props.accessibilityRole === 'button').length, 0); assert.equal(opened, 0);
      globalThis.__DEV__ = true; const screen = screenHarness('src/app/development/private-calendar-pair-preview.tsx', options);
      const button = screen.button('検査用の本人端末情報を用意する'); button.props.onPress(); button.props.onPress(); await screen.flush(); assert.equal(opened, 1); assert.equal(invoked, 1);
      release({ step: 'reference', deviceId: 'public-device', rootDigest: 'public-root', authorityDigest: 'public-authority', mainDeviceId: 'public-device', keyProof: 'synthetic-public-proof', checks: ['checked'] });
      await screen.flush(); assert.match(screen.text(), /端末間検査 PASS：reference/u); assert.equal(closed, 1);
      for (const secret of ['signingSecretKey', 'agreementSecretKey', 'accountKey']) assert.equal(screen.text().includes(secret), false);
    } finally { cleanups.forEach(fn => fn()); globalThis.__DEV__ = before; }
  });
}
