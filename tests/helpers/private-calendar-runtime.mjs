import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { privateCalendarSetupFixture } from './private-calendar-setup.mjs';
import { privateCalendarMemoryCloud } from './private-calendar-cloud.mjs';
import { createPrivateCalendarSourceStorage } from '../../src/platform/storage/private-calendar-source.ts';
import { createPrivateCalendarSourceController } from '../../src/features/sharing/private-calendar/source-controller.ts';
import { createPrivateCalendarAuthoritySync } from '../../src/features/sharing/private-calendar/authority-sync.ts';
import { createPrivateCalendarDeviceSession } from '../../src/features/sharing/private-calendar/device-session.ts';
const { createPrivateCalendarRuntime } = await import('../../src/features/sharing/private-calendar/runtime.ts');

/** Actual SQLite, protected vault, signed device controls and encryption; synthetic Google/transport only. */
export function privateCalendarRuntimeFixture(t, transport = privateCalendarMemoryCloud()) {
  const userId = 'private-runtime-owner'; const googleSubject = 'explicit-google-subject';
  const f = privateCalendarSetupFixture(t, { userId });
  const state = { now: Date.parse('2026-10-28T00:00:00.000Z'), googleReads: 0, checks: 0, consents: [], restores: 0, decrypts: 0, uploads: 0,
    account: { subject: googleSubject, label: 'Synthetic Google account' }, busy: [{ start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T01:00:00.000Z' }] };
  const assertOwner = () => assert.equal(f.state.currentUser, userId, 'owner changed');
  const source = createPrivateCalendarSourceStorage({ ownerUserId: userId, readProtected: f.readProtected, exclusive: f.exclusive, vault: f.vault, assertOwner });
  const cloud = { ...transport.cloud, async uploadCache(...args) { state.uploads++; return transport.cloud.uploadCache(...args); } };
  const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets: f.secrets, intents: f.changes, cloud });
  const sourceController = createPrivateCalendarSourceController({ userId, secrets: f.secrets, intents: f.changes, source, authoritySync });
  const devices = createPrivateCalendarDeviceSession({ userId, assertOwner, secrets: f.secrets, roots: f.roots, intents: f.changes, candidates: f.pairing, outbox: f.keyOutbox, cache: f.cache, cloud });
  const port = { userId, assertOwner, secrets: f.secrets, source, cache: { ...f.cache, async read(...args) { state.decrypts++; return f.cache.read(...args); } },
    cloud, devices, sourceController, crypto: f.gateway, timeZone: () => 'Asia/Tokyo', now: () => state.now, randomFraction: () => 0.5,
    async currentGoogleAccount() { state.checks++; return state.account; },
    async restoreGoogleAccount() { state.restores++; return state.account; },
    async authorizeGoogleSource(subject) { assert.equal(subject, state.account?.subject, 'Google account changed'); state.consents.push(subject); },
    async queryGoogle(subject) { assert.equal(subject, state.account?.subject, 'Google account changed'); state.googleReads++; return state.busy; } };
  const open = () => createPrivateCalendarRuntime(port);
  async function connect(runtime = open()) { const before = await devices.read(); return runtime.connectCurrentSource(googleSubject, before.authorityDigest); }
  return { f, state, userId, googleSubject, source, cloud, devices, sourceController, port, open, connect, transport };
}
