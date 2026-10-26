import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { randomBytes } from 'node:crypto';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import * as invitations from '../src/features/sharing/invitations.ts';
const crypto = { randomBytes: async (size) => new Uint8Array(randomBytes(size)) };
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const applicant = await createDeviceIdentity(crypto);
  const roster = createSharedRoster('household-test', 'owner', owner); const now = Date.parse('2026-10-27T00:00:00Z');
  const link = await invitations.createSharedInvitation(crypto, roster, owner, 'invite-test', now);
  return { owner, applicant, roster, now, link };
}

test('shared invitations keep their one-time secret in the app-link fragment and verify both possession and account-bound device signatures', async () => {
  const h = await fixture(); const uri = invitations.encodeSharedInvitation(h.link);
  assert.match(uri, /^houseworkplanner:\/\/sharing\/join#v1=/); assert.ok(!uri.split('#')[0].includes(h.link.seed));
  const parsed = invitations.parseSharedInvitation(uri, h.now); assert.deepEqual(parsed, h.link);
  assert.ok(!JSON.stringify(h.link.invitation).includes(h.link.seed));
  const request = invitations.createSharedJoinRequest(parsed, 'applicant', h.applicant, h.now);
  assert.deepEqual(invitations.verifySharedJoinRequest(request, h.link.invitation, 'applicant', h.now), request);
  assert.ok(!JSON.stringify(request).includes(h.link.seed));
  assert.match(invitations.sharedJoinVerificationCode(request), /^[a-f0-9]{4} [a-f0-9]{4} [a-f0-9]{4}$/);
});

test('an invitation does not grant membership and cannot be reused for another user, device, group or invitation', async () => {
  const h = await fixture(); const request = invitations.createSharedJoinRequest(h.link, 'applicant', h.applicant, h.now);
  assert.throws(() => invitations.verifySharedJoinRequest(request, h.link.invitation, 'outsider', h.now));
  for (const patch of [{ groupId: 'other' }, { inviteId: 'other' }, { userId: 'other' }, { identity: h.owner }]) {
    assert.throws(() => invitations.verifySharedJoinRequest({ ...request, body: { ...request.body, ...patch } }, h.link.invitation, 'applicant', h.now));
  }
  assert.equal(h.roster.body.members.length, 1);
  assert.throws(() => invitations.verifySharedJoinRequest({ ...request, invitationProof: '00'.repeat(64) }, h.link.invitation, 'applicant', h.now));
  assert.throws(() => invitations.verifySharedJoinRequest({ ...request, deviceProof: '00'.repeat(64) }, h.link.invitation, 'applicant', h.now));
});

test('expired, modified, oversized and foreign invitation links fail closed before sending a join request', async () => {
  const h = await fixture(); const uri = invitations.encodeSharedInvitation(h.link);
  assert.throws(() => invitations.parseSharedInvitation(uri, h.link.invitation.body.expiresAt), /期限/);
  assert.throws(() => invitations.parseSharedInvitation(uri.replace('houseworkplanner:', 'https:'), h.now));
  assert.throws(() => invitations.parseSharedInvitation('x'.repeat(12001), h.now));
  assert.throws(() => invitations.encodeSharedInvitation({ ...h.link, seed: '00'.repeat(32) }));
  assert.throws(() => invitations.validateSharedInvitation({ ...h.link.invitation,
    body: { ...h.link.invitation.body, expiresAt: h.link.invitation.body.expiresAt + 1 } }));
  await assert.rejects(invitations.createSharedInvitation(crypto, h.roster, h.applicant, 'invite-other', h.now));
});
