import './typescript-loader.mjs';
import assert from 'node:assert/strict';
import { privateCalendarSetupFixture } from './private-calendar-setup.mjs';
import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { advancePrivateCalendarAuthority, createPrivateCalendarRoot } from '../../src/features/sharing/private-calendar/authority.ts';
import { wrapPrivateCalendarKey } from '../../src/features/sharing/private-calendar/key-envelope.ts';
import { createPrivatePlannerPreferenceStore } from '../../src/features/sharing/private-planner/preference-store.ts';
import { createPrivatePreferenceSync } from '../../src/features/sharing/private-planner/preference-sync.ts';
import { privatePreferenceCursor, samePrivatePreferenceCursor, verifyEncryptedPrivatePreferences, PrivatePreferenceCloudConflict } from '../../src/features/sharing/private-planner/preference-crypto.ts';
export const privatePreferenceInput = () => ({ timeZone: 'Asia/Tokyo', restDays: [6, 7], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 },
  allowedBands: [{ weekday: 1, startMinute: 1153, endMinute: 1207 }] });

/** Real device identities, independent SQLite writers and protected vaults; this double replaces transport only. */
export async function privatePlannerSyncFixture(t, options = {}) {
  const ownerUserId = options.ownerUserId ?? 'private-planner-sync-owner';
  const left = privateCalendarSetupFixture(t, { userId: ownerUserId }); const right = privateCalendarSetupFixture(t, { userId: ownerUserId });
  const author = await left.secrets.identity(ownerUserId); const recipient = await right.secrets.identity(ownerUserId);
  const root = await createPrivateCalendarRoot(crypto, ownerUserId, author); await left.secrets.confirmTrust(ownerUserId, root, 'firstDeviceSetup');
  const authority = advancePrivateCalendarAuthority(root, { mainDeviceId: author.deviceId, devices: [author, recipient], keyVersion: 1 }, author);
  await left.secrets.acceptAuthorityUpdate(ownerUserId, authority.signed); await right.secrets.confirmTrust(ownerUserId, authority, 'approvedPairing');
  const key = await left.secrets.createCurrentKey(ownerUserId, authority);
  const received = await right.secrets.receiveCurrentKey(ownerUserId, authority, await wrapPrivateCalendarKey(crypto, key, authority, author, recipient.deviceId)); received.fill(0);
  t.after(() => key.fill(0));
  const wire = { current: null, authority, reads: 0, writes: 0, lostReply: false, unavailable: false, beforeRead: null, beforePublish: null, now: Date.parse('2026-10-29T00:00:00Z') };
  const cloud = {
    async read(expected) { wire.reads++; assert.equal(expected.digest, wire.authority.digest); if (wire.beforeRead) await wire.beforeRead(); if (wire.unavailable) throw new Error('offline'); return structuredClone(wire.current); },
    async publish(expected, input) {
      const own = verifyEncryptedPrivatePreferences(input, wire.authority); assert.equal(expected.digest, wire.authority.digest);
      if (wire.beforePublish) await wire.beforePublish(own); if (wire.unavailable) throw new Error('offline');
      const cursor = wire.current ? privatePreferenceCursor(wire.current) : null;
      if (samePrivatePreferenceCursor(cursor, privatePreferenceCursor(own))) return { published: false };
      if (!samePrivatePreferenceCursor(cursor, own.body.parent)) throw new PrivatePreferenceCloudConflict();
      wire.current = structuredClone(own); wire.writes++;
      if (wire.lostReply) { wire.lostReply = false; throw new Error('lost reply after commit'); } return { published: true };
    },
    watch() { return () => {}; },
  };
  function service(f, overrides = {}) {
    const store = createPrivatePlannerPreferenceStore({ ownerUserId, vault: f.vault, exclusive: f.exclusive,
      assertOwner: owner => assert.equal(f.state.currentUser, owner, 'owner changed'), ...overrides.storePort });
    return { f, store, sync: createPrivatePreferenceSync({ ownerUserId, store, secrets: f.secrets, crypto,
      assertOwner: () => assert.equal(f.state.currentUser, ownerUserId, 'owner changed'), cloud, now: () => wire.now, randomFraction: () => 0.5, ...overrides }) };
  }
  return { ownerUserId, author, recipient, root, authority, key, wire, cloud, left: service(left), right: service(right), service };
}
