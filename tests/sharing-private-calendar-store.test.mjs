import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createSecureVault } from '../src/features/sharing/secure-vault.ts';
import { assertPrivateCalendarProtectedAuthority, createPrivateCalendarSecretStore } from '../src/features/sharing/private-calendar/secret-store.ts';
import { createPrivateCalendarRoot, advancePrivateCalendarAuthority } from '../src/features/sharing/private-calendar/authority.ts';
import { wrapPrivateCalendarKey } from '../src/features/sharing/private-calendar/key-envelope.ts';

const userId = 'private-key-owner';
function deviceFixture() {
  const values = new Map(); let currentUser = userId; let writes = 0; let generations = 0; let afterWrite = () => {}; let afterExclusive = () => {}; let tail = Promise.resolve();
  const vault = createSecureVault({ get: async key => values.get(key) ?? null,
    set: async (key, value) => { values.set(key, value); writes++; }, remove: async key => { values.delete(key); } }, crypto.randomBytes);
  const port = { crypto: { ...crypto, randomBytes: async length => { generations++; return crypto.randomBytes(length); } },
    vault: { getItem: key => vault.getItem(key), setItem: async (...args) => { await vault.setItem(...args); await afterWrite(); } },
    assertOwner: expected => { if (expected !== currentUser) throw new Error('account changed'); },
    exclusive: (_expected, work) => { const run = async () => { const value = await work(); await afterExclusive(value); return value; };
      const result = tail.then(run, run); tail = result.catch(() => {}); return result; },
  };
  return { values, vault, port, store: createPrivateCalendarSecretStore(port), reopen: () => createPrivateCalendarSecretStore(port),
    switchUser: uid => { currentUser = uid; }, afterWrite: callback => { afterWrite = callback; }, afterExclusive: callback => { afterExclusive = callback; }, writes: () => writes, generations: () => generations };
}
async function setup() {
  const a = deviceFixture(); const identity = await a.store.identity(userId); const root = await createPrivateCalendarRoot(crypto, userId, identity);
  await a.store.confirmTrust(userId, root, 'firstDeviceSetup');
  return { a, identity, root };
}
async function pair() {
  const f = await setup(); const b = deviceFixture(); const second = await b.store.identity(userId);
  const joined = advancePrivateCalendarAuthority(f.root, { mainDeviceId: f.identity.deviceId, devices: [f.identity, second], keyVersion: 1 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, joined.signed); await b.store.confirmTrust(userId, joined, 'approvedPairing');
  const key = await f.a.store.createCurrentKey(userId, joined);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, joined, f.identity, second.deviceId);
  await b.store.receiveCurrentKey(userId, joined, wrapped);
  return { ...f, b, second, joined, key };
}

test('private Calendar key store persists independent device keys and an explicitly pinned root across process reconstruction', async () => {
  const f = await setup(); const key = await f.a.store.createCurrentKey(userId, f.root);
  const reopened = f.a.reopen(); const restored = await reopened.authority(userId);
  assert.equal((await reopened.identity(userId)).deviceId, f.identity.deviceId); assert.equal(restored.digest, f.root.digest);
  const read = await reopened.currentKey(userId, restored); assert.ok(read.every((byte, index) => byte === key[index]));
  const before = f.a.writes(); await reopened.confirmTrust(userId, restored, 'firstDeviceSetup'); await reopened.createCurrentKey(userId, restored);
  assert.equal(f.a.writes(), before, 'retrying setup or key creation must not rewrite protected storage');
});

test('private Calendar key store serializes one hundred simultaneous identity and key requests without duplicate key generations', async () => {
  const a = deviceFixture(); const identities = await Promise.all(Array.from({ length: 100 }, () => a.store.identity(userId)));
  assert.equal(new Set(identities.map(identity => identity.deviceId)).size, 1); assert.equal(a.generations(), 2);
  const root = await createPrivateCalendarRoot(crypto, userId, identities[0]); await a.store.confirmTrust(userId, root, 'firstDeviceSetup');
  const before = a.generations(); const keys = await Promise.all(Array.from({ length: 100 }, () => a.store.createCurrentKey(userId, root)));
  assert.equal(a.generations(), before + 1); assert.ok(keys.every(key => key.every((byte, index) => byte === keys[0][index])));
});

test('private Calendar additional devices cannot create a replacement key and must receive the same key through explicit approval', async () => {
  const f = await setup(); const b = deviceFixture(); const second = await b.store.identity(userId);
  const joined = advancePrivateCalendarAuthority(f.root, { mainDeviceId: f.identity.deviceId, devices: [f.identity, second], keyVersion: 1 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, joined.signed);
  await assert.rejects(() => b.store.confirmTrust(userId, joined, 'firstDeviceSetup'), /初回/u);
  await b.store.confirmTrust(userId, joined, 'approvedPairing'); await assert.rejects(() => b.store.createCurrentKey(userId, joined), /受け取/u);
  assert.equal(await b.store.currentKey(userId, joined), null);
  const key = await f.a.store.createCurrentKey(userId, joined);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, joined, f.identity, second.deviceId);
  await b.store.receiveCurrentKey(userId, joined, wrapped); const before = b.writes();
  const read = await b.reopen().receiveCurrentKey(userId, joined, wrapped); assert.equal(b.writes(), before);
  assert.ok(read.every((byte, index) => byte === key[index]));
});

test('private Calendar protected authority resumes after the old signer revokes itself and only the remaining main can generate a new future key', async () => {
  const f = await pair();
  const revoked = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.second.deviceId, devices: [f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, revoked.signed); await f.b.store.acceptAuthorityUpdate(userId, revoked.signed);
  const restored = await f.b.reopen().authority(userId); assert.equal(restored.digest, revoked.digest);
  assert.equal(restored.signer.deviceId, f.identity.deviceId); assert.equal(restored.signed.body.devices.some(device => device.deviceId === f.identity.deviceId), false);
  await assert.rejects(() => f.a.store.currentKey(userId, revoked), /解除/u);
  await assert.rejects(() => f.a.store.createCurrentKey(userId, revoked), /解除/u);
  const future = await f.b.store.createCurrentKey(userId, restored); assert.ok(future.some((byte, index) => byte !== f.key[index]));
  assert.equal((await f.b.reopen().currentKey(userId, restored)).length, 32);
  await assert.rejects(() => f.a.store.confirmTrust(userId, f.root, 'firstDeviceSetup'), /更新/u);
});

test('private Calendar stored authority rejects skipped revisions, forked branches and attempted root replacement instead of accepting a later timestamp', async () => {
  const f = await pair(); const before = f.a.writes();
  const fork = advancePrivateCalendarAuthority(f.root, { mainDeviceId: f.second.deviceId, devices: [f.identity, f.second], keyVersion: 1 }, f.identity);
  await assert.rejects(() => f.a.store.acceptAuthorityUpdate(userId, fork.signed), /更新/u);
  const replacement = await createPrivateCalendarRoot(crypto, userId, f.identity);
  await assert.rejects(() => f.a.store.confirmTrust(userId, replacement, 'firstDeviceSetup'), /更新/u);
  await assert.rejects(() => f.a.store.acceptAuthorityUpdate(userId, { signed: f.joined.signed, signer: f.identity }));
  assert.equal(f.a.writes(), before);
  const third = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.second.deviceId, devices: [f.identity, f.second], keyVersion: 1 }, f.identity);
  const fourth = advancePrivateCalendarAuthority(third, { mainDeviceId: f.identity.deviceId, devices: [f.identity, f.second], keyVersion: 1 }, f.second);
  await assert.rejects(() => f.a.store.acceptAuthorityUpdate(userId, fourth.signed), /更新/u);
  await f.a.store.acceptAuthorityUpdate(userId, third.signed); await f.a.store.acceptAuthorityUpdate(userId, fourth.signed);
  assert.equal((await f.a.reopen().authority(userId)).digest, fourth.digest);
});

test('private Calendar exact authority retries remain idempotent when transport object keys arrive in a different order', async () => {
  const f = await pair(); const before = f.a.writes();
  const reordered = value => Array.isArray(value) ? value.map(reordered) : value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).reverse().map(([key, field]) => [key, reordered(field)])) : value;
  assert.equal((await f.a.store.acceptAuthorityUpdate(userId, reordered(f.joined.signed))).digest, f.joined.digest);
  assert.equal(f.a.writes(), before);
});

test('private Calendar key store never replaces a current key with a different valid envelope for the same generation', async () => {
  const f = await pair(); const falseKey = new Uint8Array(randomBytes(32));
  const wrapped = await wrapPrivateCalendarKey(crypto, falseKey, f.joined, f.identity, f.second.deviceId); const before = f.b.writes();
  await assert.rejects(() => f.b.store.receiveCurrentKey(userId, f.joined, wrapped), /異なる/u);
  assert.equal(f.b.writes(), before); const preserved = await f.b.store.currentKey(userId, f.joined);
  assert.ok(preserved.every((byte, index) => byte === f.key[index]));
});

test('private Calendar secret writes recheck the owner after a durable native commit and recover that exact key after the original user returns', async () => {
  const f = await setup(); const before = f.a.generations(); f.a.afterWrite(() => f.a.switchUser('another-user'));
  await assert.rejects(() => f.a.store.createCurrentKey(userId, f.root), /account changed/u);
  await assert.rejects(() => f.a.store.currentKey(userId, f.root), /account changed/u);
  f.a.switchUser(userId); f.a.afterWrite(() => {});
  const saved = await f.a.reopen().currentKey(userId, f.root); assert.equal(saved.length, 32);
  await f.a.store.createCurrentKey(userId, f.root); assert.equal(f.a.generations(), before + 1);
});

test('private Calendar key results stay guarded while the external SQLite lock is committing after SecureStore completed', async () => {
  const f = await setup(); let heldResult;
  f.a.afterExclusive(value => { heldResult = value; f.a.switchUser('another-user'); });
  await assert.rejects(() => f.a.store.createCurrentKey(userId, f.root), /account changed/u);
  assert.ok(heldResult instanceof Uint8Array && heldResult.every(byte => byte === 0), 'unreturned plaintext must be cleared after the owner changes');
  f.a.switchUser(userId); f.a.afterExclusive(() => {});
  assert.equal((await f.a.reopen().currentKey(userId, f.root)).length, 32, 'the original owner can recover the durable key without creating another');
});

test('private Calendar corrupted protected records fail closed and never silently regenerate a device, root or key', async () => {
  const f = await setup(); await f.a.store.createCurrentKey(userId, f.root);
  const recordName = `private-calendar-state:${userId}`; const original = await f.a.vault.getItem(recordName);
  const foreign = await createPrivateCalendarRoot(crypto, 'another-user', f.identity);
  for (const value of ['{invalid private record', JSON.stringify({ ...JSON.parse(original), ownerUserId: 'another-user' }),
    JSON.stringify({ ...JSON.parse(original), anchor: foreign.anchor, checkpoint: { signed: foreign.signed, signer: foreign.signer } }),
    JSON.stringify({ ...JSON.parse(original), keys: [{ keyVersion: 1, value: 'not-a-key' }] })]) {
    await f.a.vault.setItem(recordName, value); const before = f.a.writes();
    await assert.rejects(() => f.a.reopen().identity(userId)); await assert.rejects(() => f.a.reopen().createCurrentKey(userId, f.root));
    assert.equal(f.a.writes(), before);
  }
  await f.a.vault.setItem(recordName, original); assert.equal((await f.a.reopen().currentKey(userId, f.root)).length, 32);
});

test('private Calendar already-locked cache checks distinguish the approved reader from the main publisher and reject a revoked identity', async () => {
  const f = await pair(); const name = `private-calendar-state:${userId}`;
  const first = await f.a.vault.getItem(name); const second = await f.b.vault.getItem(name);
  assert.doesNotThrow(() => assertPrivateCalendarProtectedAuthority(first, userId, f.joined, true));
  assert.doesNotThrow(() => assertPrivateCalendarProtectedAuthority(second, userId, f.joined, false));
  assert.throws(() => assertPrivateCalendarProtectedAuthority(second, userId, f.joined, true), /メイン/u);
  assert.throws(() => assertPrivateCalendarProtectedAuthority(second, 'another-owner', f.joined), /アカウント/u);
  const removed = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.identity.deviceId, devices: [f.identity], keyVersion: 2 }, f.identity);
  await f.b.store.acceptAuthorityUpdate(userId, removed.signed);
  assert.throws(() => assertPrivateCalendarProtectedAuthority(null, userId, removed), /準備/u);
  const revoked = await f.b.vault.getItem(name);
  assert.throws(() => assertPrivateCalendarProtectedAuthority(revoked, userId, removed), /承認/u);
});

test('private Calendar a new main missing the latest key cannot generate a different key for the same existing generation', async () => {
  const f = await pair();
  const rotated = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.identity.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, rotated.signed); await f.b.store.acceptAuthorityUpdate(userId, rotated.signed);
  const original = await f.a.store.createCurrentKey(userId, rotated);
  const switched = advancePrivateCalendarAuthority(rotated, { mainDeviceId: f.second.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, switched.signed); await f.b.store.acceptAuthorityUpdate(userId, switched.signed);
  await assert.rejects(() => f.b.store.createCurrentKey(userId, switched), /鍵|生成/u);
  const wrapped = await wrapPrivateCalendarKey(crypto, original, switched, f.identity, f.second.deviceId);
  assert.deepEqual(await f.b.store.receiveCurrentKey(userId, switched, wrapped), original);
  assert.deepEqual(await f.b.store.createCurrentKey(userId, switched), original); original.fill(0);
});

test('private Calendar the original key issuer can finish its pending generation after a main switch without changing the generation', async () => {
  const f = await pair();
  const rotated = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.identity.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, rotated.signed); await f.b.store.acceptAuthorityUpdate(userId, rotated.signed);
  const switched = advancePrivateCalendarAuthority(rotated, { mainDeviceId: f.second.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, switched.signed); await f.b.store.acceptAuthorityUpdate(userId, switched.signed);
  const key = await f.a.store.createCurrentKey(userId, switched);
  await assert.rejects(() => f.b.store.createCurrentKey(userId, switched), /鍵|生成/u);
  const wrapped = await wrapPrivateCalendarKey(crypto, key, switched, f.identity, f.second.deviceId);
  assert.deepEqual(await f.b.store.receiveCurrentKey(userId, switched, wrapped), key); key.fill(0);
});

test('private Calendar a verified new rotation can appoint its issuer even when that approved device missed an older key generation', async () => {
  const f = await pair();
  const skipped = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.identity.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.b.store.acceptAuthorityUpdate(userId, skipped.signed);
  const current = advancePrivateCalendarAuthority(skipped, { mainDeviceId: f.second.deviceId, devices: [f.identity, f.second], keyVersion: 3 }, f.identity);
  await f.b.store.acceptAuthorityUpdate(userId, current.signed);
  const key = await f.b.store.createCurrentKey(userId, current); assert.equal(key.length, 32);
  assert.deepEqual(await f.b.reopen().currentKey(userId, current), key); key.fill(0);
});

test('private Calendar a newly approved issuer can create its explicitly rotated key without receiving a revoked generation', async () => {
  const f = await setup(); const b = deviceFixture(); const second = await b.store.identity(userId);
  const joined = advancePrivateCalendarAuthority(f.root, { mainDeviceId: f.identity.deviceId, devices: [f.identity, second], keyVersion: 1 }, f.identity);
  await b.store.confirmTrust(userId, joined, 'approvedPairing'); await assert.rejects(() => b.store.createCurrentKey(userId, joined), /生成/u);
  const rotated = advancePrivateCalendarAuthority(joined, { mainDeviceId: second.deviceId, devices: [second], keyVersion: 2 }, f.identity);
  await b.store.acceptAuthorityUpdate(userId, rotated.signed); const key = await b.store.createCurrentKey(userId, rotated);
  assert.equal(key.length, 32); assert.deepEqual(await b.reopen().currentKey(userId, rotated), key); key.fill(0);
});

test('private Calendar legacy checkpoints keep existing keys readable and recover missing issuer metadata only from the complete pinned signature chain', async () => {
  const f = await pair(); const name = `private-calendar-state:${userId}`;
  const legacy = JSON.parse(await f.a.vault.getItem(name)); delete legacy.checkpoint.keyIssuer; await f.a.vault.setItem(name, JSON.stringify(legacy));
  assert.equal((await f.a.reopen().authority(userId)).keyIssuer, null);
  assert.deepEqual(await f.a.reopen().currentKey(userId, f.joined), f.key);
  const before = f.a.writes();
  const impostor = await createPrivateCalendarRoot(crypto, userId, f.second);
  for (const chain of [[impostor.signed], [f.root.signed], [f.joined.signed], [f.root.signed, f.joined.signed, f.joined.signed]]) {
    await assert.rejects(() => f.a.store.recoverKeyIssuerHistory(userId, chain)); assert.equal(f.a.writes(), before);
  }
  const restored = await f.a.store.recoverKeyIssuerHistory(userId, [f.root.signed, f.joined.signed]);
  assert.deepEqual(restored.keyIssuer, { deviceId: f.identity.deviceId, revision: 1 });
  assert.equal(restored.digest, f.joined.digest); assert.deepEqual(await f.a.reopen().currentKey(userId, restored), f.key);
  const wrote = f.a.writes(); await f.a.store.recoverKeyIssuerHistory(userId, [f.root.signed, f.joined.signed]); assert.equal(f.a.writes(), wrote);
});

test('private Calendar legacy missing-generation recovery never guesses a new key and authenticates its original issuer before generating once', async () => {
  const f = await pair();
  const rotated = advancePrivateCalendarAuthority(f.joined, { mainDeviceId: f.identity.deviceId, devices: [f.identity, f.second], keyVersion: 2 }, f.identity);
  await f.a.store.acceptAuthorityUpdate(userId, rotated.signed);
  const name = `private-calendar-state:${userId}`; const saved = JSON.parse(await f.a.vault.getItem(name)); delete saved.checkpoint.keyIssuer;
  await f.a.vault.setItem(name, JSON.stringify(saved)); const generations = f.a.generations();
  await assert.rejects(() => f.a.reopen().createCurrentKey(userId, rotated), /署名履歴/u); assert.equal(f.a.generations(), generations);
  await f.a.store.recoverKeyIssuerHistory(userId, [f.root.signed, f.joined.signed, rotated.signed]);
  const key = await f.a.store.createCurrentKey(userId, rotated); assert.equal(f.a.generations(), generations + 1);
  assert.deepEqual(await f.a.reopen().createCurrentKey(userId, rotated), key); assert.equal(f.a.generations(), generations + 1); key.fill(0);
});

test('private Calendar protected issuer metadata rejects impossible fields rather than silently granting a different key generator', async () => {
  const f = await pair(); const name = `private-calendar-state:${userId}`; const saved = JSON.parse(await f.a.vault.getItem(name));
  for (const keyIssuer of [false, 0, '', { deviceId: 'not-approved', revision: 1 }, { deviceId: f.identity.deviceId, revision: 0 },
    { deviceId: f.identity.deviceId, revision: 9 }, { deviceId: f.identity.deviceId, revision: 1, untrusted: true }]) {
    await f.a.vault.setItem(name, JSON.stringify({ ...saved, checkpoint: { ...saved.checkpoint, keyIssuer } })); const before = f.a.writes();
    await assert.rejects(() => f.a.reopen().authority(userId)); await assert.rejects(() => f.a.reopen().createCurrentKey(userId, f.joined)); assert.equal(f.a.writes(), before);
  }
  await f.a.vault.setItem(name, JSON.stringify(saved)); assert.deepEqual(await f.a.reopen().currentKey(userId, f.joined), f.key);
});

test('private Calendar issuer-history recovery owns every signed input before its first asynchronous account check', async () => {
  const f = await pair(); const name = `private-calendar-state:${userId}`; const saved = JSON.parse(await f.a.vault.getItem(name)); delete saved.checkpoint.keyIssuer;
  await f.a.vault.setItem(name, JSON.stringify(saved)); const history = JSON.parse(JSON.stringify([f.root.signed, f.joined.signed]));
  let release; let entered; const gate = new Promise(resolve => { release = resolve; }); const ready = new Promise(resolve => { entered = resolve; });
  let once = true; const assertOwner = f.a.port.assertOwner;
  f.a.port.assertOwner = async expected => { if (once) { once = false; entered(); await gate; } return assertOwner(expected); };
  const restoring = f.a.store.recoverKeyIssuerHistory(userId, history); await ready;
  history[0].body.devices[0].signingPublicKey = '0'.repeat(64); history[1].body.previousDigest = '0'.repeat(64); release();
  assert.deepEqual((await restoring).keyIssuer, { deviceId: f.identity.deviceId, revision: 1 });
  assert.deepEqual(await f.a.reopen().currentKey(userId, f.joined), f.key);
});
