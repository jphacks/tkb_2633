import { x25519 } from '@noble/curves/ed25519.js';
import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { signSharedDocument, validateDeviceSecretIdentity, verifySharedDocument } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';
import { exactRecord, hexBytes } from './validation.ts';

const SUITE = 'liflow-private-calendar-key-x25519-hkdfsha256-aes256gcm-ed25519-v1';
interface KeyHeader {
  schemaVersion: 1; suite: typeof SUITE; ownerUserId: string; accountGeneration: string; authorityDigest: string;
  keyVersion: number; revision: number; senderDeviceId: string; recipientDeviceId: string;
  ephemeralPublicKey: string; salt: string; nonce: string;
}
export interface WrappedPrivateCalendarKey { body: KeyHeader & { encryptedKey: string }; signature: string }
const HEADER_FIELDS = ['schemaVersion', 'suite', 'ownerUserId', 'accountGeneration', 'authorityDigest', 'keyVersion', 'revision', 'senderDeviceId', 'recipientDeviceId', 'ephemeralPublicKey', 'salt', 'nonce'];
const utf8 = (value: unknown) => new TextEncoder().encode(canonicalJson(value));

/** Copy bounded transport metadata before a storage/authentication await. This is not an approval check. */
export function snapshotPrivateCalendarWrappedKey(wrapped: WrappedPrivateCalendarKey): WrappedPrivateCalendarKey {
  exactRecord(wrapped, ['body', 'signature']); exactRecord(wrapped.body, [...HEADER_FIELDS, 'encryptedKey']);
  hexBytes(wrapped.signature, 64);
  for (const value of Object.values(wrapped.body)) if (!(typeof value === 'string' && value.length <= 256 || Number.isSafeInteger(value))) throw new Error('本人用の鍵情報が大きすぎるか無効です。');
  return { body: { ...wrapped.body }, signature: wrapped.signature };
}

export async function createPrivateCalendarAccountKey(crypto: SharingCryptoGateway): Promise<Uint8Array> {
  const key = await crypto.randomBytes(32); if (key.length !== 32) throw new Error('安全な本人用の鍵を生成できません。'); return key;
}
/** Approval and a fresh key on revocation precede this transport step; group memberships grant no access. */
export async function wrapPrivateCalendarKey(crypto: SharingCryptoGateway, accountKey: Uint8Array, authority: VerifiedPrivateCalendarAuthority,
  sender: DeviceSecretIdentity, recipientDeviceId: string): Promise<WrappedPrivateCalendarKey> {
  sender = validateDeviceSecretIdentity(sender); const state = authority.signed.body;
  const recipient = state.devices.find((device) => device.deviceId === recipientDeviceId);
  if (accountKey.length !== 32 || !recipient || !state.devices.some((device) => device.deviceId === sender.deviceId)) throw new Error('本人用の鍵は承認済み端末にだけ渡せます。');
  const privateKey = accountKey.slice();
  let ephemeral: Uint8Array | undefined; let shared: Uint8Array | undefined; let derived: Uint8Array | undefined;
  try {
    ephemeral = await crypto.randomBytes(32);
    const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
    if (ephemeral.length !== 32 || salt.length !== 32 || nonce.length !== 12) throw new Error('安全な乱数を生成できません。');
    const header: KeyHeader = { schemaVersion: 1, suite: SUITE, ownerUserId: state.ownerUserId, accountGeneration: state.accountGeneration,
      authorityDigest: authority.digest, keyVersion: state.keyVersion, revision: state.revision, senderDeviceId: sender.deviceId, recipientDeviceId,
      ephemeralPublicKey: bytesToHex(x25519.getPublicKey(ephemeral)), salt: bytesToHex(salt), nonce: bytesToHex(nonce) };
    const aad = utf8(header); shared = x25519.getSharedSecret(ephemeral, hexBytes(recipient.agreementPublicKey, 32));
    derived = hkdf(sha256, shared, salt, aad, 32);
    const encrypted = await crypto.encrypt(derived, nonce, privateKey, aad);
    if (encrypted.length !== 48) throw new Error('本人用の鍵を暗号化できませんでした。');
    const body = { ...header, encryptedKey: bytesToHex(encrypted) };
    return { body, signature: signSharedDocument(body, sender) };
  } finally { privateKey.fill(0); ephemeral?.fill(0); shared?.fill(0); derived?.fill(0); }
}
export async function unwrapPrivateCalendarKey(crypto: SharingCryptoGateway, wrapped: WrappedPrivateCalendarKey,
  authority: VerifiedPrivateCalendarAuthority, recipient: DeviceSecretIdentity): Promise<Uint8Array> {
  validateDeviceSecretIdentity(recipient); wrapped = snapshotPrivateCalendarWrappedKey(wrapped);
  const { encryptedKey, ...header } = wrapped.body; const state = authority.signed.body;
  const sender = state.devices.find((device) => device.deviceId === header.senderDeviceId);
  if (header.schemaVersion !== 1 || header.suite !== SUITE || header.ownerUserId !== state.ownerUserId || header.accountGeneration !== state.accountGeneration
    || header.authorityDigest !== authority.digest || header.revision !== state.revision || header.keyVersion !== state.keyVersion || !sender
    || header.recipientDeviceId !== recipient.deviceId || !state.devices.some((device) => device.deviceId === recipient.deviceId)) throw new Error('本人用の鍵の宛先・承認世代が異なります。');
  const ciphertext = hexBytes(encryptedKey, 48); const salt = hexBytes(header.salt, 32); const nonce = hexBytes(header.nonce, 12); hexBytes(wrapped.signature, 64);
  verifySharedDocument(wrapped.body, wrapped.signature, sender);
  const aad = utf8(header); const shared = x25519.getSharedSecret(hexBytes(recipient.agreementSecretKey, 32), hexBytes(header.ephemeralPublicKey, 32));
  const derived = hkdf(sha256, shared, salt, aad, 32);
  try {
    const key = await crypto.decrypt(derived, nonce, ciphertext, aad);
    if (key.length !== 32) { key.fill(0); throw new Error('本人用の鍵を復号できませんでした。'); }
    return key;
  } finally { shared.fill(0); derived.fill(0); }
}
