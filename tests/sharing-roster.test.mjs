import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createDeviceIdentity, signSharedDocument, validateDevicePublicIdentity } from '../src/features/sharing/crypto.ts';
import { approveSharedDevice, createSharedRoster, removeSharedMember, sharedAuthorIdentity,
  sharedRosterDigest, validateSharedRoster, verifyPinnedSharedRoster, verifySharedRosterTransition,
  transferSharedOwnership, removeSharedDevice, verifySharedRosterArchive } from '../src/features/sharing/roster.ts';

const crypto = { async randomBytes(n) { return new Uint8Array(randomBytes(n)); } };
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const initial = createSharedRoster('group-test', 'owner-user', owner);
  return { owner, member, initial };
}

test('a shared roster contains only public device keys and starts with the creators pinned authority', async () => {
  const h = await fixture();
  const serialized = JSON.stringify(h.initial);
  assert.equal(serialized.includes(h.owner.signingSecretKey), false); assert.equal(serialized.includes(h.owner.agreementSecretKey), false);
  const verified = verifyPinnedSharedRoster(h.initial, { groupId: 'group-test', digest: sharedRosterDigest(h.initial),
    ownerUserId: 'owner-user', ownerIdentity: validateDevicePublicIdentity(h.owner) });
  assert.deepEqual(verified, h.initial);
  assert.throws(() => verifyPinnedSharedRoster(h.initial, { groupId: 'other-group', digest: sharedRosterDigest(h.initial),
    ownerUserId: 'owner-user', ownerIdentity: validateDevicePublicIdentity(h.owner) }), /trusted invitation/);
});

test('joining requires an existing owner signature, rotates the key epoch and cannot impersonate an existing device', async () => {
  const h = await fixture();
  const next = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  assert.equal(next.body.members.length, 2); assert.equal(next.body.revision, 2); assert.equal(next.body.keyVersion, 2);
  assert.equal(next.body.members.find((member) => member.userId === 'member-user').joinedKeyVersion, 2);
  assert.deepEqual(verifySharedRosterTransition(h.initial, next), next);
  assert.throws(() => approveSharedDevice(h.initial, h.member, 'member-user', h.member), /current owner/);
  assert.throws(() => approveSharedDevice(next, h.owner, 'intruder', h.member), /already approved/);
  assert.throws(() => sharedAuthorIdentity(next, 'owner-user', h.member.deviceId, 2), /approved device/);
  assert.throws(() => sharedAuthorIdentity(next, 'member-user', h.member.deviceId, 1), /approved device/);
});

test('tampering, owner substitution, rollback and skipping a roster revision cannot replace a trusted membership state', async () => {
  const h = await fixture(); const next = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  assert.throws(() => validateSharedRoster({ ...next, body: { ...next.body, ownerUserId: 'attacker' } }));
  assert.throws(() => verifySharedRosterTransition(next, h.initial), /rollback/);
  const body = { ...next.body, revision: 3, keyVersion: 3 };
  const forged = { body, signer: validateDevicePublicIdentity(h.member),
    signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, h.member) };
  assert.throws(() => verifySharedRosterTransition(h.initial, forged), /Untrusted/);
  const wrongSigner = { ...next, signer: validateDevicePublicIdentity(h.member),
    signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body: next.body }, h.member) };
  assert.throws(() => verifySharedRosterTransition(h.initial, wrongSigner), /Untrusted/);
});

test('removal denies a former member and rejoining cannot replay edits from before the new approval epoch', async () => {
  const h = await fixture(); const joined = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  const removed = removeSharedMember(joined, h.owner, 'member-user');
  assert.equal(removed.body.keyVersion, 3);
  assert.throws(() => sharedAuthorIdentity(removed, 'member-user', h.member.deviceId, 2), /approved device/);
  const rejoined = approveSharedDevice(removed, h.owner, 'member-user', h.member);
  assert.throws(() => sharedAuthorIdentity(rejoined, 'member-user', h.member.deviceId, 2), /approved device/);
  assert.deepEqual(sharedAuthorIdentity(rejoined, 'member-user', h.member.deviceId, 4), validateDevicePublicIdentity(h.member));
});

test('owner departure explicitly transfers control to a remaining approved device before future membership changes', async () => {
  const h = await fixture(); const joined = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  assert.throws(() => removeSharedMember(joined, h.owner, 'owner-user'), /next owner/);
  const transferred = transferSharedOwnership(joined, h.owner, { userId: 'member-user', deviceId: h.member.deviceId });
  assert.equal(transferred.body.ownerUserId, 'member-user'); assert.equal(transferred.body.ownerDeviceId, h.member.deviceId);
  assert.ok(transferred.body.members.some((member) => member.userId === 'owner-user'));
  assert.throws(() => approveSharedDevice(transferred, h.owner, 'other', h.owner), /current owner/);
  const departed = removeSharedMember(transferred, h.member, 'owner-user');
  assert.equal(departed.signer.deviceId, h.member.deviceId); assert.equal(departed.body.keyVersion, 4);
  assert.ok(!departed.body.members.some((member) => member.userId === 'owner-user'));
  const another = await createDeviceIdentity(crypto);
  assert.equal(approveSharedDevice(departed, h.member, 'other', another).body.keyVersion, 5);
});

test('the final owner can close a group and its old roster can never authorize new operations or members', async () => {
  const h = await fixture(); const closed = removeSharedMember(h.initial, h.owner, 'owner-user');
  assert.equal(closed.body.closed, true); assert.equal(closed.body.members.length, 0);
  assert.throws(() => sharedAuthorIdentity(closed, 'owner-user', h.owner.deviceId, 1), /approved device/);
  assert.throws(() => approveSharedDevice(closed, h.owner, 'member-user', h.member), /current owner/);
});

test('a compromised old owner cannot combine their removal and a new-owner transition while generating the future key', async () => {
  const h = await fixture(); const joined = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  const transfer = transferSharedOwnership(joined, h.owner, { userId: 'member-user', deviceId: h.member.deviceId });
  const body = { ...transfer.body, members: transfer.body.members.filter((member) => member.userId !== 'owner-user') };
  const unsafe = { body, signer: validateDevicePublicIdentity(h.owner), signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, h.owner) };
  assert.throws(() => verifySharedRosterTransition(joined, unsafe), /successor must generate/);
});

test('device removal rotates authority without removing another device on the same account and history remains pinned', async () => {
  const h = await fixture(); const extra = await createDeviceIdentity(crypto);
  const second = approveSharedDevice(h.initial, h.owner, 'owner-user', extra);
  assert.throws(() => removeSharedDevice(second, h.owner, h.owner.deviceId), /Transfer/);
  const third = removeSharedDevice(second, h.owner, extra.deviceId);
  assert.equal(third.body.members.length, 1); assert.equal(third.body.members[0].devices.length, 1); assert.equal(third.body.keyVersion, 3);
  assert.deepEqual(verifySharedRosterArchive(second, [h.initial, second, third]), [h.initial, second, third]);
  assert.throws(() => verifySharedRosterArchive(second, [h.initial, third]));
  const stranger = createSharedRoster('group-test', 'owner-user', extra);
  assert.throws(() => verifySharedRosterArchive(second, [stranger, second, third]));
});

test('rosters reject secret key fields and a new device cannot claim an earlier approval epoch', async () => {
  const h = await fixture(); const joined = approveSharedDevice(h.initial, h.owner, 'member-user', h.member);
  const leaked = JSON.parse(JSON.stringify(joined)); leaked.signer.signingSecretKey = h.owner.signingSecretKey;
  assert.throws(() => validateSharedRoster(leaked), /roster field/);
  const modified = JSON.parse(JSON.stringify(joined));
  const device = modified.body.members.find((member) => member.userId === 'member-user');
  device.joinedKeyVersion = 1; device.devices[0].joinedKeyVersion = 1;
  modified.signature = signSharedDocument({ domain: 'liflow-shared-roster-v1', body: modified.body }, h.owner);
  assert.throws(() => verifySharedRosterTransition(h.initial, modified), /approval epoch/);
});
