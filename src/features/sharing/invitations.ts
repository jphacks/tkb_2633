import { ed25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js';
import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from './operations.ts';
import { signSharedDocument, validateDevicePublicIdentity, verifySharedDocument } from './crypto.ts';
import type { DevicePublicIdentity, DeviceSecretIdentity, SharingCryptoGateway } from './crypto.ts';
import { sharedRosterDigest } from './roster.ts';
import type { VerifiedSharedRoster } from './roster.ts';

export interface SharedInvitationPin {
  groupId: string; digest: string; revision: number; ownerUserId: string; ownerIdentity: DevicePublicIdentity;
}
export interface SharedInvitationBody {
  schemaVersion: 1; inviteId: string; groupId: string; invitationPublicKey: string; expiresAt: number; pin: SharedInvitationPin;
}
export interface SignedSharedInvitation { body: SharedInvitationBody; signature: string }
export interface SharedInvitationLink { invitation: SignedSharedInvitation; seed: string }
export interface SharedJoinRequest {
  body: { schemaVersion: 1; inviteId: string; groupId: string; userId: string; identity: DevicePublicIdentity };
  invitationProof: string; deviceProof: string;
}
const PREFIX = 'houseworkplanner://sharing/join#v1=';
const COMPACT_PREFIX = 'houseworkplanner://sharing/join#v2=';
function exact(input: unknown, keys: string[]): void {
  assertJsonRecord(input);
  if (Object.keys(input).sort().join(',') !== keys.sort().join(',')) throw new Error('Unknown invitation field');
}
function seedBytes(value: string): Uint8Array {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/u.test(value)) throw new Error('Invalid invitation secret');
  return hexToBytes(value);
}

export function validateSharedInvitation(input: SignedSharedInvitation): SignedSharedInvitation {
  exact(input, ['body', 'signature']); const { body } = input;
  exact(body, ['schemaVersion', 'inviteId', 'groupId', 'invitationPublicKey', 'expiresAt', 'pin']);
  exact(body.pin, ['groupId', 'digest', 'revision', 'ownerUserId', 'ownerIdentity']);
  exact(body.pin.ownerIdentity, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  if (body.schemaVersion !== 1 || body.pin.groupId !== body.groupId || !Number.isSafeInteger(body.expiresAt)
    || !Number.isSafeInteger(body.pin.revision) || body.pin.revision < 1 || !/^[a-f0-9]{64}$/u.test(body.pin.digest)) {
    throw new Error('Invalid invitation context');
  }
  for (const id of [body.inviteId, body.groupId, body.pin.ownerUserId]) assertSharedIdentifier(id);
  seedBytes(body.invitationPublicKey); validateDevicePublicIdentity(body.pin.ownerIdentity);
  verifySharedDocument({ domain: 'liflow-shared-invitation-v1', body }, input.signature, body.pin.ownerIdentity);
  return JSON.parse(canonicalJson(input)) as SignedSharedInvitation;
}

export async function createSharedInvitation(crypto: SharingCryptoGateway, roster: VerifiedSharedRoster,
  owner: DeviceSecretIdentity, inviteId: string, now: number, validityMs = 60 * 60_000): Promise<SharedInvitationLink> {
  assertSharedIdentifier(inviteId);
  if (roster.body.closed || roster.body.ownerDeviceId !== owner.deviceId || !Number.isSafeInteger(now)
    || !Number.isSafeInteger(validityMs) || validityMs < 60_000 || validityMs > 24 * 60 * 60_000) throw new Error('Invalid invitation authority or duration');
  const secret = await crypto.randomBytes(32); if (secret.length !== 32) throw new Error('Secure random source failed');
  const body: SharedInvitationBody = { schemaVersion: 1, inviteId, groupId: roster.body.groupId,
    invitationPublicKey: bytesToHex(ed25519.getPublicKey(secret)), expiresAt: now + validityMs,
    pin: { groupId: roster.body.groupId, digest: sharedRosterDigest(roster), revision: roster.body.revision,
      ownerUserId: roster.body.ownerUserId, ownerIdentity: validateDevicePublicIdentity(owner) } };
  const invitation = validateSharedInvitation({ body, signature: signSharedDocument({ domain: 'liflow-shared-invitation-v1', body }, owner) });
  return { invitation, seed: bytesToHex(secret) };
}

/** The one-time invitation seed remains in the fragment, never in an HTTP request or cloud document. */
export function encodeSharedInvitation(link: SharedInvitationLink): string {
  const invitation = validateSharedInvitation(link.invitation);
  if (bytesToHex(ed25519.getPublicKey(seedBytes(link.seed))) !== invitation.body.invitationPublicKey) throw new Error('Invitation secret does not match');
  return PREFIX + encodeURIComponent(canonicalJson({ invitation, seed: link.seed }));
}
/** A compact wire tuple improves QR readability; signatures still cover the full original contract. */
export function encodeCompactSharedInvitation(link: SharedInvitationLink): string {
  encodeSharedInvitation(link);
  const { body, signature } = link.invitation; const { pin } = body; const owner = pin.ownerIdentity;
  return COMPACT_PREFIX + encodeURIComponent(canonicalJson([body.inviteId, body.groupId, body.invitationPublicKey, body.expiresAt,
    pin.digest, pin.revision, pin.ownerUserId, owner.deviceId, owner.signingPublicKey, owner.agreementPublicKey, signature, link.seed]));
}
export function parseSharedInvitation(value: string, now: number): SharedInvitationLink {
  if (typeof value !== 'string' || value.length > 12000 || (!value.startsWith(PREFIX) && !value.startsWith(COMPACT_PREFIX))) throw new Error('LiFlowの有効な招待リンクを入力してください。');
  let result: SharedInvitationLink;
  if (value.startsWith(COMPACT_PREFIX)) {
    const tuple = JSON.parse(decodeURIComponent(value.slice(COMPACT_PREFIX.length)));
    if (!Array.isArray(tuple) || tuple.length !== 12 || tuple.some((part, index) => typeof part !== ([3, 5].includes(index) ? 'number' : 'string'))) throw new Error('Invalid compact invitation');
    const [inviteId, groupId, invitationPublicKey, expiresAt, digest, revision, ownerUserId, deviceId, signingPublicKey, agreementPublicKey, signature, seed] = tuple;
    result = { invitation: { body: { schemaVersion: 1, inviteId, groupId, invitationPublicKey, expiresAt,
      pin: { groupId, digest, revision, ownerUserId, ownerIdentity: { deviceId, signingPublicKey, agreementPublicKey } } }, signature }, seed };
  } else result = JSON.parse(decodeURIComponent(value.slice(PREFIX.length))) as SharedInvitationLink;
  exact(result, ['invitation', 'seed']); validateSharedInvitation(result.invitation); encodeSharedInvitation(result);
  if (result.invitation.body.expiresAt <= now) throw new Error('この招待リンクは期限が切れています。');
  return result;
}

export function createSharedJoinRequest(link: SharedInvitationLink, userId: string, identity: DeviceSecretIdentity, now: number): SharedJoinRequest {
  validateSharedInvitation(link.invitation); encodeSharedInvitation(link); assertSharedIdentifier(userId);
  if (link.invitation.body.expiresAt <= now) throw new Error('Invitation expired');
  const body: SharedJoinRequest['body'] = { schemaVersion: 1, inviteId: link.invitation.body.inviteId,
    groupId: link.invitation.body.groupId, userId, identity: validateDevicePublicIdentity(identity) };
  const bytes = new TextEncoder().encode(canonicalJson({ domain: 'liflow-shared-invitation-request-v1', body }));
  const invitationProof = bytesToHex(ed25519.sign(bytes, seedBytes(link.seed)));
  return { body, invitationProof, deviceProof: signSharedDocument({ domain: 'liflow-shared-join-device-v1', body, invitationProof }, identity) };
}

export function verifySharedJoinRequest(input: SharedJoinRequest, invitationInput: SignedSharedInvitation,
  authenticatedUserId: string, now: number): SharedJoinRequest {
  const invitation = validateSharedInvitation(invitationInput); exact(input, ['body', 'invitationProof', 'deviceProof']);
  exact(input.body, ['schemaVersion', 'inviteId', 'groupId', 'userId', 'identity']);
  exact(input.body.identity, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  const { body } = input;
  if (body.schemaVersion !== 1 || body.inviteId !== invitation.body.inviteId || body.groupId !== invitation.body.groupId
    || body.userId !== authenticatedUserId || invitation.body.expiresAt <= now) throw new Error('Join request identity or invitation mismatch');
  assertSharedIdentifier(body.userId); validateDevicePublicIdentity(body.identity);
  if (typeof input.invitationProof !== 'string' || !/^[a-f0-9]{128}$/u.test(input.invitationProof)
    || !ed25519.verify(hexToBytes(input.invitationProof),
      new TextEncoder().encode(canonicalJson({ domain: 'liflow-shared-invitation-request-v1', body })),
      seedBytes(invitation.body.invitationPublicKey), { zip215: false })) throw new Error('Invitation possession proof failed');
  verifySharedDocument({ domain: 'liflow-shared-join-device-v1', body, invitationProof: input.invitationProof }, input.deviceProof, body.identity);
  return JSON.parse(canonicalJson(input)) as SharedJoinRequest;
}

export function sharedJoinVerificationCode(request: SharedJoinRequest): string {
  const hash = bytesToHex(sha256(new TextEncoder().encode(canonicalJson(request))));
  return `${hash.slice(0, 4)} ${hash.slice(4, 8)} ${hash.slice(8, 12)}`;
}
