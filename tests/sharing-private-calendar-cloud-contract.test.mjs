import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { advancePrivateCalendarAuthority, createPrivateCalendarRoot } from '../src/features/sharing/private-calendar/authority.ts';
import { assertPrivateCalendarCloudAuthority, parsePrivateCalendarCloudHead, privateCalendarCloudFields, snapshotPrivateCalendarCloudCacheHead } from '../src/features/sharing/private-calendar/cloud-contract.ts';
import { verifyPrivateCalendarWrappedKey, wrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';
import { sealPrivateCalendarCache, snapshotPrivateCalendarCacheManifest } from '../src/features/sharing/private-calendar/cache-crypto.ts';

async function fixture() {
  const main = await createDeviceIdentity(crypto); const second = await createDeviceIdentity(crypto);
  const root = await createPrivateCalendarRoot(crypto, 'private-cloud-owner', main); return { main, second, root };
}

test('private Calendar Cloud metadata is a bounded owned public copy and cannot substitute for protected verified authority', async () => {
  const f = await fixture(); const fields = privateCalendarCloudFields(f.root); const parsed = parsePrivateCalendarCloudHead(fields, 'private-cloud-owner');
  assertPrivateCalendarCloudAuthority(parsed, f.root); fields.deviceIds[0] = 'mutable-device';
  assert.equal(parsed.deviceIds[0], f.main.deviceId); assert.equal('anchor' in parsed, false); assert.equal('signer' in parsed, false); assert.equal('signed' in parsed, false);
  for (const secret of [f.main.signingSecretKey, f.main.agreementSecretKey, 'calendarBinding', 'intervals']) assert.equal(JSON.stringify(parsed).includes(secret), false);
});

test('private Calendar Cloud metadata rejects foreign owners, unknown fields, oversized JSON and signed-header mismatches', async () => {
  const f = await fixture(); const head = privateCalendarCloudFields(f.root);
  const mutations = [{ ownerUserId: 'another-owner' }, { privateBusy: [] }, { authorityJson: ' '.repeat(16001) }, { authorityDigest: '0'.repeat(64) },
    { authorityRevision: 2 }, { keyVersion: 2 }, { mainDeviceId: f.second.deviceId }, { deviceIds: [f.main.deviceId, f.second.deviceId] }, { deviceIds: [] }, { authorityRevision: Number.MAX_SAFE_INTEGER + 1 }];
  for (const patch of mutations) assert.throws(() => parsePrivateCalendarCloudHead({ ...head, ...patch }, 'private-cloud-owner'));
  const other = await createPrivateCalendarRoot(crypto, 'private-cloud-owner', f.second);
  const substituted = parsePrivateCalendarCloudHead(privateCalendarCloudFields(other), 'private-cloud-owner');
  assert.throws(() => assertPrivateCalendarCloudAuthority(substituted, f.root), { code: 'private-calendar/conflict' });
});

test('private Calendar Cloud cache metadata bounds all pieces and sequences and never accepts Google bindings in its public shape', () => {
  const head = { cacheId: '1'.repeat(64), manifestDigest: '2'.repeat(64), authorityDigest: '3'.repeat(64), sequence: 1, chunkCount: 32 };
  const copy = snapshotPrivateCalendarCloudCacheHead(head); head.sequence = 2; assert.equal(copy.sequence, 1);
  for (const patch of [{ cacheId: '../another-user' }, { chunkCount: 33 }, { chunkCount: 0 }, { sequence: Number.MAX_SAFE_INTEGER + 1 }, { calendarBinding: 'must-stay-private' }]) assert.throws(() => snapshotPrivateCalendarCloudCacheHead({ ...copy, ...patch }));
});

test('private Calendar wrapped-key transport authenticates its public envelope without accessing a recipient secret and owns that checked copy', async () => {
  const f = await fixture(); const authority = advancePrivateCalendarAuthority(f.root, { devices: [f.main, f.second], mainDeviceId: f.main.deviceId, keyVersion: 1 }, f.main);
  const wrapped = await wrapPrivateCalendarKey(crypto, new Uint8Array(32).fill(7), authority, f.main, f.second.deviceId);
  const owned = verifyPrivateCalendarWrappedKey(wrapped, authority, f.second.deviceId); const before = owned.body.encryptedKey;
  wrapped.body.encryptedKey = '0'.repeat(96); assert.equal(owned.body.encryptedKey, before);
  assert.throws(() => verifyPrivateCalendarWrappedKey(wrapped, authority, f.second.deviceId));
  assert.throws(() => verifyPrivateCalendarWrappedKey(owned, f.root, f.second.deviceId), /承認世代/u);
  assert.throws(() => verifyPrivateCalendarWrappedKey({ ...owned, groupId: 'public-group' }, authority, f.second.deviceId));
});

test('private Calendar cache manifest transport binds its signature to the current authority and owns the complete digest list', async () => {
  const f = await fixture(); const key = new Uint8Array(32).fill(3); const calendarBinding = 'private-binding';
  const cache = { ownerUserId: 'private-cloud-owner', accountGeneration: f.root.signed.body.accountGeneration, mainDeviceId: f.main.deviceId, mainRevision: 1,
    calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00Z', coverage: { start: '2026-10-28T00:00:00Z', end: '2026-10-29T00:00:00Z' }, intervals: [] };
  const encrypted = await sealPrivateCalendarCache(crypto, { cache, authority: f.root, calendarBinding, accountKey: key, mainDevice: f.main, sequence: 1 });
  const owned = snapshotPrivateCalendarCacheManifest(encrypted.manifest, f.root); const before = owned.body.chunkDigests[0];
  encrypted.manifest.body.chunkDigests[0] = '0'.repeat(64); assert.equal(owned.body.chunkDigests[0], before);
  assert.throws(() => snapshotPrivateCalendarCacheManifest(encrypted.manifest, f.root));
  assert.throws(() => snapshotPrivateCalendarCacheManifest({ ...owned, plaintextDigest: '0'.repeat(64) }, f.root)); key.fill(0);
});
