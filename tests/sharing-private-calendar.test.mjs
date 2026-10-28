import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, sharedDocumentDigest, signSharedDocument } from '../src/features/sharing/crypto.ts';
import { createPrivateCalendarRoot, advancePrivateCalendarAuthority, verifyPrivateCalendarRoot,
  verifyPrivateCalendarAuthorityUpdate } from '../src/features/sharing/private-calendar/authority.ts';
import { sealPrivateCalendarCache, openPrivateCalendarCache, advancePrivateCalendarCacheCursor,
  PRIVATE_CALENDAR_CHUNK_BYTES } from '../src/features/sharing/private-calendar/cache-crypto.ts';
import { createPrivateCalendarReader } from '../src/features/sharing/v2/private-availability.ts';
import { createPrivateCalendarAccountKey, wrapPrivateCalendarKey, unwrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';

const clone = (value) => JSON.parse(JSON.stringify(value));
async function fixture() {
  const main = await createDeviceIdentity(crypto); const second = await createDeviceIdentity(crypto); const outsider = await createDeviceIdentity(crypto);
  const authority = await createPrivateCalendarRoot(crypto, 'private-owner', main); const accountKey = new Uint8Array(randomBytes(32));
  const calendarBinding = 'private-google-binding';
  const cache = { ownerUserId: authority.signed.body.ownerUserId, accountGeneration: authority.signed.body.accountGeneration,
    mainDeviceId: main.deviceId, mainRevision: 1, calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-28T00:00:00.000Z',
    coverage: { start: '2026-10-28T00:00:00.000Z', end: '2026-11-28T00:00:00.000Z' },
    intervals: [{ start: '2026-10-28T01:00:00.000Z', end: '2026-10-28T02:00:00.000Z' }] };
  const seal = (changes = {}) => sealPrivateCalendarCache(crypto, { cache, authority, calendarBinding, accountKey, mainDevice: main, sequence: 1, ...changes });
  const open = (encrypted, changes = {}) => openPrivateCalendarCache(crypto, encrypted, { authority, calendarBinding, accountKey, ...changes });
  return { main, second, outsider, authority, accountKey, calendarBinding, cache, seal, open };
}

test('private Calendar trust starts from an independently pinned root and cannot be replaced by another authenticated cloud key', async () => {
  const f = await fixture(); const candidate = await createPrivateCalendarRoot(crypto, 'private-owner', f.outsider);
  assert.throws(() => verifyPrivateCalendarRoot(candidate.signed, f.authority.anchor), /信頼情報/u);
  assert.throws(() => verifyPrivateCalendarRoot(f.authority.signed, { ...f.authority.anchor, ownerUserId: 'another-member' }), /信頼情報/u);
  assert.throws(() => verifyPrivateCalendarRoot({ ...clone(f.authority.signed), groupId: 'public-group' }, f.authority.anchor));
  const copy = clone(f.authority.signed); copy.body.devices[0].signingSecretKey = '0'.repeat(64);
  assert.throws(() => verifyPrivateCalendarRoot(copy, f.authority.anchor));
  assert.throws(() => { f.authority.signed.body.devices[0].signingPublicKey = '0'.repeat(64); }, TypeError);
});

test('private Calendar device approval requires a previous approved signer and concurrent main changes cannot silently replace one another', async () => {
  const f = await fixture(); const change = { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 };
  const joined = advancePrivateCalendarAuthority(f.authority, change, f.main);
  assert.equal(joined.signed.body.revision, 2); assert.equal(joined.anchor.rootDigest, f.authority.anchor.rootDigest);
  assert.throws(() => advancePrivateCalendarAuthority(f.authority, change, f.second), /未承認/u);
  const mainChanged = advancePrivateCalendarAuthority(joined, { ...change, mainDeviceId: f.second.deviceId }, f.second);
  assert.equal(mainChanged.signed.body.mainDeviceId, f.second.deviceId);
  assert.throws(() => verifyPrivateCalendarAuthorityUpdate(mainChanged, joined.signed), /更新/u);
  const competing = advancePrivateCalendarAuthority(joined, { ...change, devices: [...change.devices, f.outsider] }, f.main);
  assert.equal(competing.signed.body.revision, mainChanged.signed.body.revision);
  assert.throws(() => verifyPrivateCalendarAuthorityUpdate(mainChanged, competing.signed), /更新/u);
  assert.equal(advancePrivateCalendarAuthority(joined, change, f.main), joined, 'exact retry should not invalidate a valid cache');
});

test('private Calendar device revocation forces a new key version and revoked device signatures cannot regain access', async () => {
  const f = await fixture();
  const joined = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  assert.throws(() => advancePrivateCalendarAuthority(joined, { mainDeviceId: f.main.deviceId, devices: [f.main], keyVersion: 1 }, f.main), /新しい鍵/u);
  const removed = advancePrivateCalendarAuthority(joined, { mainDeviceId: f.main.deviceId, devices: [f.main], keyVersion: 2 }, f.main);
  assert.throws(() => advancePrivateCalendarAuthority(removed, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 2 }, f.second), /未承認/u);
  assert.throws(() => advancePrivateCalendarAuthority(removed, { mainDeviceId: f.main.deviceId, devices: [f.main], keyVersion: 4 }, f.main), /鍵/u);
  assert.throws(() => advancePrivateCalendarAuthority(removed, { mainDeviceId: f.second.deviceId, devices: [f.main], keyVersion: 2 }, f.main), /端末/u);
});

test('private Calendar authority rejects altered signatures, owner changes, skipped revisions and unbounded device registrations', async () => {
  const f = await fixture(); const joined = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  for (const change of [{ ownerUserId: 'another-member' }, { accountGeneration: 'replacement-generation' }, { revision: 10 }, { keyVersion: 0 }, { previousDigest: '0'.repeat(64) }, { suite: 'group-roster-v1' }]) {
    const value = clone(joined.signed); Object.assign(value.body, change); value.signature = signSharedDocument(value.body, f.main);
    assert.throws(() => verifyPrivateCalendarAuthorityUpdate(f.authority, value));
  }
  const modified = clone(joined.signed); modified.body.mainDeviceId = f.second.deviceId;
  assert.throws(() => verifyPrivateCalendarAuthorityUpdate(f.authority, modified), /authentication/u);
  const oversized = clone(joined.signed); oversized.body.devices = Array(17).fill(oversized.body.devices[0]);
  assert.throws(() => verifyPrivateCalendarAuthorityUpdate(f.authority, oversized), /数/u);
  await assert.rejects(() => createPrivateCalendarRoot({ ...crypto, randomBytes: async () => new Uint8Array(31) }, 'private-owner', f.main), /乱数/u);
});

test('private Calendar encrypted cache keeps intervals and Google binding private and uses an independent account key', async () => {
  const f = await fixture(); const encrypted = await f.seal();
  assert.equal(JSON.stringify(encrypted).includes(f.calendarBinding), false);
  assert.equal(JSON.stringify(encrypted).includes(f.cache.intervals[0].start), false);
  assert.equal(JSON.stringify(encrypted).includes('Asia/Tokyo'), false);
  const cache = await f.open(encrypted); assert.deepEqual(cache, f.cache);
  const binding = Object.fromEntries(['ownerUserId', 'accountGeneration', 'mainDeviceId', 'mainRevision', 'calendarBinding'].map((key) => [key, cache[key]]));
  const read = createPrivateCalendarReader(cache, binding, Date.parse(cache.fetchedAt));
  assert.deepEqual(read({ precision: 'interval', start: '2026-10-28T01:30:00Z', end: '2026-10-28T02:30:00Z' }), { kind: 'conflict' });
  assert.deepEqual(read({ precision: 'interval', start: '2026-10-28T02:00:00Z', end: '2026-10-28T02:30:00Z' }), { kind: 'clear' });
  const groupKey = new Uint8Array(randomBytes(32));
  await assert.rejects(() => f.open(encrypted, { accountKey: groupKey }));
  await assert.rejects(() => f.open(encrypted, { calendarBinding: 'a-different-google-session' }), /接続先/u);
  assert.deepEqual(createPrivateCalendarReader(cache, { ...binding, ownerUserId: 'another-member' }, Date.parse(cache.fetchedAt))({ precision: 'interval', start: '2026-10-28T02:00:00Z', end: '2026-10-28T02:30:00Z' }), { kind: 'unknown', reason: 'binding' });
});

test('private Calendar ciphertext part digests match independent Node SHA256 over bounded metadata and actual ciphertext bytes', async () => {
  const f = await fixture(); const encrypted = await f.seal();
  for (const chunk of encrypted.chunks) {
    const ciphertext = Buffer.from(chunk.encryptedPayload, 'hex');
    const context = { suite: `${encrypted.manifest.body.suite}:part`, index: chunk.index, salt: chunk.salt, nonce: chunk.nonce, bytes: ciphertext.length };
    const encoded = JSON.stringify(context, Object.keys(context).sort());
    assert.equal(encrypted.manifest.body.chunkDigests[chunk.index], createHash('sha256').update(encoded).update(ciphertext).digest('hex'));
  }
});

test('private Calendar accelerated SHA256 preserves the portable wire format and either implementation opens the other ciphertext', async () => {
  const f = await fixture();
  const random = () => { let part = 1; return async length => new Uint8Array(length).fill(part++); };
  const portable = { ...crypto, randomBytes: random() }; let digestCalls = 0;
  const accelerated = { ...crypto, randomBytes: random(), digestSha256: async bytes => { digestCalls++; return new Uint8Array(createHash('sha256').update(bytes).digest()); } };
  const input = { cache: f.cache, authority: f.authority, calendarBinding: f.calendarBinding, accountKey: f.accountKey, mainDevice: f.main, sequence: 1 };
  const first = await sealPrivateCalendarCache(portable, input); const second = await sealPrivateCalendarCache(accelerated, input);
  assert.deepEqual(second, first, 'deterministic synthetic transport must have identical signatures, headers and ciphertext');
  const options = { authority: f.authority, calendarBinding: f.calendarBinding, accountKey: f.accountKey };
  assert.deepEqual(await openPrivateCalendarCache(accelerated, first, options), f.cache);
  assert.deepEqual(await openPrivateCalendarCache(portable, second, options), f.cache);
  assert.equal(digestCalls, first.chunks.length * 2);
});

test('private Calendar native hash failure cannot publish an incomplete manifest or decrypt unverified ciphertext', async () => {
  const f = await fixture(); const encrypted = await f.seal(); let decryptions = 0;
  const faulty = { ...crypto, digestSha256: async () => new Uint8Array(31), decrypt: async (...args) => { decryptions++; return crypto.decrypt(...args); } };
  const options = { authority: f.authority, calendarBinding: f.calendarBinding, accountKey: f.accountKey };
  await assert.rejects(() => sealPrivateCalendarCache(faulty, { ...options, cache: f.cache, mainDevice: f.main, sequence: 1 }), /検証/u);
  await assert.rejects(() => openPrivateCalendarCache(faulty, encrypted, options), /検証/u); assert.equal(decryptions, 0);
});

test('private Calendar encryption snapshots its account key and requested sequence before native asynchronous work', async () => {
  const f = await fixture(); const originalKey = f.accountKey.slice(); let entered; let resume;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { resume = resolve; }); let first = true;
  const delayed = { ...crypto, randomBytes: async length => { if (first) { first = false; entered(); await gate; } return crypto.randomBytes(length); } };
  const input = { cache: f.cache, authority: f.authority, calendarBinding: f.calendarBinding, accountKey: f.accountKey, mainDevice: f.main, sequence: 1 };
  const pending = sealPrivateCalendarCache(delayed, input); await started; input.accountKey.fill(9); input.sequence = 99; resume();
  const encrypted = await pending; assert.equal(encrypted.manifest.body.sequence, 1);
  assert.deepEqual(await f.open(encrypted, { accountKey: originalKey }), f.cache);
});

test('private Calendar decryption snapshots the authenticated manifest, pieces and key across native hash awaits', async () => {
  const f = await fixture(); const encrypted = await f.seal(); let entered; let resume; let first = true;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { resume = resolve; });
  const delayed = { ...crypto, digestSha256: async bytes => { if (first) { first = false; entered(); await gate; } return new Uint8Array(createHash('sha256').update(bytes).digest()); } };
  const pending = openPrivateCalendarCache(delayed, encrypted, { authority: f.authority, accountKey: f.accountKey, calendarBinding: f.calendarBinding });
  await started; f.accountKey.fill(9); encrypted.manifest.body.chunkDigests[0] = '00'.repeat(32); encrypted.chunks[0].encryptedPayload = 'ff'.repeat(20); resume();
  assert.deepEqual(await pending, f.cache);
});

test('private Calendar key wrapping snapshots the private key before requesting native randomness', async () => {
  const f = await fixture(); const originalKey = f.accountKey.slice(); let entered; let resume; let first = true;
  const started = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { resume = resolve; });
  const delayed = { ...crypto, randomBytes: async length => { if (first) { first = false; entered(); await gate; } return crypto.randomBytes(length); } };
  const pending = wrapPrivateCalendarKey(delayed, f.accountKey, f.authority, f.main, f.main.deviceId);
  await started; f.accountKey.fill(9); resume(); const wrapped = await pending;
  const received = await unwrapPrivateCalendarKey(crypto, wrapped, f.authority, f.main);
  assert.ok(received.every((byte, index) => byte === originalKey[index]), 'native key preparation must not observe a later account-key mutation');
});

test('private Calendar cache creation refuses secondary devices and account or main-generation mismatches before encryption', async () => {
  const f = await fixture();
  await assert.rejects(() => f.seal({ mainDevice: f.second }), /メイン端末/u);
  for (const patch of [{ ownerUserId: 'other-user' }, { accountGeneration: 'old-generation' }, { mainDeviceId: f.second.deviceId }, { mainRevision: 2 }, { calendarBinding: 'other-google' }]) {
    await assert.rejects(() => f.seal({ cache: { ...f.cache, ...patch } }), /接続先/u);
  }
  await assert.rejects(() => f.seal({ cache: { ...f.cache, eventTitle: 'never store Calendar contents' } }), /情報/u);
  await assert.rejects(() => f.seal({ cache: { ...f.cache, intervals: Array(20_001).fill(f.cache.intervals[0]) } }), /情報/u);
  await assert.rejects(() => f.seal({ cache: { ...f.cache, coverage: { start: '2026-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z' } } }), /範囲/u);
  await assert.rejects(() => f.seal({ sequence: 0 }), /連番/u);
});

test('private Calendar twenty thousand busy intervals are encrypted in bounded parts and reversed delivery reconstructs the same exact conflict data', async () => {
  const f = await fixture(); const start = Date.parse('2026-01-01T00:00:00Z');
  const intervals = Array.from({ length: 20_000 }, (_, index) => ({ start: new Date(start + index * 20 * 60_000).toISOString(), end: new Date(start + (index * 20 + 5) * 60_000).toISOString() }));
  const cache = { ...f.cache, coverage: { start: new Date(start).toISOString(), end: '2027-01-01T00:00:00.000Z' }, intervals };
  const encrypted = await f.seal({ cache });
  assert.ok(encrypted.chunks.length > 10); assert.ok(encrypted.chunks.length <= 32);
  assert.ok(encrypted.chunks.every((chunk) => chunk.encryptedPayload.length <= (PRIVATE_CALENDAR_CHUNK_BYTES + 16) * 2));
  assert.deepEqual(await f.open({ ...encrypted, chunks: [...encrypted.chunks].reverse() }), cache);
});

test('private Calendar missing, duplicate, swapped, oversized or tampered parts are rejected before any plaintext is decrypted', async () => {
  const f = await fixture(); const start = Date.parse('2026-01-01T00:00:00Z');
  const intervals = Array.from({ length: 1_500 }, (_, n) => ({ start: new Date(start + n * 120_000).toISOString(), end: new Date(start + n * 120_000 + 60_000).toISOString() }));
  const encrypted = await f.seal({ cache: { ...f.cache, coverage: { start: '2026-01-01T00:00:00.000Z', end: '2026-11-28T00:00:00.000Z' }, intervals } });
  assert.ok(encrypted.chunks.length > 1); let decryptions = 0;
  const counting = { ...crypto, decrypt: async (...args) => { decryptions++; return crypto.decrypt(...args); } };
  const candidates = [
    { ...clone(encrypted), chunks: encrypted.chunks.slice(1) },
    { ...clone(encrypted), chunks: encrypted.chunks.map(() => encrypted.chunks[0]) },
    (() => { const value = clone(encrypted); value.chunks[0].encryptedPayload = '00'.repeat(PRIVATE_CALENDAR_CHUNK_BYTES + 17); return value; })(),
    (() => { const value = clone(encrypted); value.chunks.at(-1).encryptedPayload = 'ff' + value.chunks.at(-1).encryptedPayload.slice(2); return value; })(),
    (() => { const value = clone(encrypted); value.chunks[0].nonce = '00'.repeat(12); return value; })(),
    (() => { const value = clone(encrypted); value.chunks[0].index = 0.5; return value; })(),
    (() => { const value = clone(encrypted); value.chunks[0].title = 'forbidden-extra'; return value; })(),
  ];
  for (const value of candidates) await assert.rejects(() => openPrivateCalendarCache(counting, value, { authority: f.authority, accountKey: f.accountKey, calendarBinding: f.calendarBinding }));
  assert.equal(decryptions, 0);
});

test('private Calendar cache authentication rejects altered manifests, another owner and every obsolete authority after a main switch', async () => {
  const f = await fixture(); const encrypted = await f.seal();
  for (const change of [{ sequence: 2 }, { ownerUserId: 'other-user' }, { authorityDigest: '0'.repeat(64) }, { suite: 'liflow-snapshot-aes256gcm-hkdfsha256-ed25519-v1' }, { chunkCount: 33 }]) {
    const value = clone(encrypted); Object.assign(value.manifest.body, change); await assert.rejects(() => f.open(value));
  }
  const joined = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.second.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  await assert.rejects(() => f.open(encrypted, { authority: joined }), /世代/u);
  const nextCache = { ...f.cache, mainDeviceId: f.second.deviceId, mainRevision: joined.signed.body.revision };
  const second = await f.seal({ authority: joined, cache: nextCache, mainDevice: f.second });
  assert.deepEqual(await f.open(second, { authority: joined }), nextCache);
  await assert.rejects(() => f.open(second), /世代/u);
});

test('private Calendar sequence cursors reject delayed overwrites and same-sequence forks while exact saved envelopes remain idempotent', async () => {
  const f = await fixture(); const first = await f.seal(); const next = await f.seal({ sequence: 2 });
  const initial = advancePrivateCalendarCacheCursor(null, first.manifest, f.authority);
  assert.equal(initial.kind, 'new'); assert.equal(advancePrivateCalendarCacheCursor(initial.cursor, first.manifest, f.authority).kind, 'duplicate');
  const updated = advancePrivateCalendarCacheCursor(initial.cursor, next.manifest, f.authority);
  assert.equal(updated.kind, 'new'); assert.throws(() => advancePrivateCalendarCacheCursor(updated.cursor, first.manifest, f.authority), /古い/u);
  const fork = await f.seal({ sequence: 2 });
  assert.notEqual(sharedDocumentDigest(fork.manifest), updated.cursor.manifestDigest, 'fresh encryption must not reuse a nonce envelope');
  assert.throws(() => advancePrivateCalendarCacheCursor(updated.cursor, fork.manifest, f.authority), /連番/u);
});

test('private Calendar cursor retains the highest authority revision and rejects a server rollback, authority fork or unapproved new account generation', async () => {
  const f = await fixture(); const first = await f.seal();
  const original = advancePrivateCalendarCacheCursor(null, first.manifest, f.authority).cursor;
  const joined = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.second.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  const updated = await f.seal({ authority: joined, mainDevice: f.second, cache: { ...f.cache, mainDeviceId: f.second.deviceId, mainRevision: 2 } });
  const next = advancePrivateCalendarCacheCursor(original, updated.manifest, joined).cursor;
  assert.equal(next.authorityRevision, 2); assert.equal(next.sequence, 1);
  assert.throws(() => advancePrivateCalendarCacheCursor(next, first.manifest, f.authority), /巻き戻/u);
  const fork = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  const forkCache = await f.seal({ authority: fork, cache: { ...f.cache, mainRevision: 2 } });
  assert.throws(() => advancePrivateCalendarCacheCursor(next, forkCache.manifest, fork), /巻き戻/u);
  const replacement = await createPrivateCalendarRoot(crypto, 'private-owner', f.main);
  const replacedCache = await f.seal({ authority: replacement, cache: { ...f.cache, accountGeneration: replacement.signed.body.accountGeneration } });
  assert.throws(() => advancePrivateCalendarCacheCursor(next, replacedCache.manifest, replacement), /復旧/u);
});

test('private Calendar normalizes overlaps and clipping without inventing free time when cache or coverage becomes stale', async () => {
  const f = await fixture(); const encrypted = await f.seal({ cache: { ...f.cache, intervals: [
    { start: '2026-10-27T23:00:00Z', end: '2026-10-28T01:15:00Z' },
    { start: '2026-10-28T01:00:00+00:00', end: '2026-10-28T02:00:00+00:00' },
    { start: '2026-12-01T00:00:00Z', end: '2026-12-01T01:00:00Z' },
  ] } });
  const cache = await f.open(encrypted); assert.deepEqual(cache.intervals, [{ start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T02:00:00.000Z' }]);
  const target = { precision: 'interval', start: '2026-12-01T01:00:00Z', end: '2026-12-01T02:00:00Z' };
  const binding = Object.fromEntries(['ownerUserId', 'accountGeneration', 'mainDeviceId', 'mainRevision', 'calendarBinding'].map((key) => [key, cache[key]]));
  assert.deepEqual(createPrivateCalendarReader(cache, binding, Date.parse(cache.fetchedAt))(target), { kind: 'unknown', reason: 'coverage' });
  assert.deepEqual(createPrivateCalendarReader(cache, binding, Date.parse(cache.fetchedAt) + 37 * 3_600_000)(target), { kind: 'unknown', reason: 'stale' });
});

test('private Calendar keys reach only explicitly approved devices and a different group member cannot unwrap them', async () => {
  const f = await fixture();
  const authority = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  const key = await createPrivateCalendarAccountKey(crypto); assert.equal(key.length, 32);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, authority, f.main, f.second.deviceId);
  assert.deepEqual(await unwrapPrivateCalendarKey(crypto, wrapped, authority, f.second), key);
  assert.equal(JSON.stringify(wrapped).includes(Buffer.from(key).toString('hex')), false);
  assert.equal('groupId' in wrapped.body, false);
  await assert.rejects(() => unwrapPrivateCalendarKey(crypto, wrapped, authority, f.outsider), /宛先/u);
  await assert.rejects(() => wrapPrivateCalendarKey(crypto, key, authority, f.main, f.outsider.deviceId), /承認済み/u);
  await assert.rejects(() => wrapPrivateCalendarKey(crypto, key, authority, f.outsider, f.second.deviceId), /承認済み/u);
});

test('private Calendar wrapped keys bind the account, authority revision and recipient against key substitution and tampering', async () => {
  const f = await fixture();
  const authority = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  const wrapped = await wrapPrivateCalendarKey(crypto, f.accountKey, authority, f.main, f.second.deviceId);
  for (const patch of [{ ownerUserId: 'another-member' }, { recipientDeviceId: f.main.deviceId }, { keyVersion: 2 }, { authorityDigest: '0'.repeat(64) }, { suite: 'liflow-x25519-hkdfsha256-aes256gcm-ed25519-v1' }]) {
    const value = clone(wrapped); Object.assign(value.body, patch); value.signature = signSharedDocument(value.body, f.main);
    await assert.rejects(() => unwrapPrivateCalendarKey(crypto, value, authority, f.second), /宛先/u);
  }
  const tampered = clone(wrapped); tampered.body.encryptedKey = '00'.repeat(48); tampered.signature = signSharedDocument(tampered.body, f.main);
  await assert.rejects(() => unwrapPrivateCalendarKey(crypto, tampered, authority, f.second));
  const extra = { ...clone(wrapped), privateKey: '00'.repeat(32) };
  await assert.rejects(() => unwrapPrivateCalendarKey(crypto, extra, authority, f.second));
  await assert.rejects(() => unwrapPrivateCalendarKey(crypto, wrapped, authority, { ...f.second, agreementSecretKey: f.outsider.agreementSecretKey }), /match/u);
});

test('private Calendar revocation rotates actual key material so the removed device and old group keys cannot decrypt future cache data', async () => {
  const f = await fixture();
  const joined = advancePrivateCalendarAuthority(f.authority, { mainDeviceId: f.main.deviceId, devices: [f.main, f.second], keyVersion: 1 }, f.main);
  const oldWrap = await wrapPrivateCalendarKey(crypto, f.accountKey, joined, f.main, f.second.deviceId);
  const removedDeviceKey = await unwrapPrivateCalendarKey(crypto, oldWrap, joined, f.second); assert.deepEqual(removedDeviceKey, f.accountKey);
  const removed = advancePrivateCalendarAuthority(joined, { mainDeviceId: f.main.deviceId, devices: [f.main], keyVersion: 2 }, f.main);
  const nextKey = await createPrivateCalendarAccountKey(crypto); assert.notDeepEqual(nextKey, removedDeviceKey);
  const cache = { ...f.cache, mainRevision: removed.signed.body.revision };
  const encrypted = await f.seal({ authority: removed, cache, accountKey: nextKey });
  assert.deepEqual(await f.open(encrypted, { authority: removed, accountKey: nextKey }), cache);
  await assert.rejects(() => f.open(encrypted, { authority: removed, accountKey: removedDeviceKey }));
  await assert.rejects(() => unwrapPrivateCalendarKey(crypto, oldWrap, removed, f.second), /宛先/u);
  await assert.rejects(() => wrapPrivateCalendarKey(crypto, nextKey, removed, f.main, f.second.deviceId), /承認済み/u);
});

test('private Calendar transport fails closed when native random or encryption gateways return incomplete results', async () => {
  const f = await fixture();
  const shortRandom = { ...crypto, randomBytes: async (length) => new Uint8Array(length - 1) };
  await assert.rejects(() => createPrivateCalendarAccountKey(shortRandom), /安全/u);
  await assert.rejects(() => wrapPrivateCalendarKey(shortRandom, f.accountKey, f.authority, f.main, f.main.deviceId), /安全/u);
  await assert.rejects(() => sealPrivateCalendarCache(shortRandom, { cache: f.cache, authority: f.authority, calendarBinding: f.calendarBinding,
    accountKey: f.accountKey, mainDevice: f.main, sequence: 1 }), /安全/u);
  const shortCipher = { ...crypto, encrypt: async () => new Uint8Array(16) };
  await assert.rejects(() => wrapPrivateCalendarKey(shortCipher, f.accountKey, f.authority, f.main, f.main.deviceId), /暗号化/u);
  await assert.rejects(() => sealPrivateCalendarCache(shortCipher, { cache: f.cache, authority: f.authority, calendarBinding: f.calendarBinding,
    accountKey: f.accountKey, mainDevice: f.main, sequence: 1 }), /暗号化/u);
});
