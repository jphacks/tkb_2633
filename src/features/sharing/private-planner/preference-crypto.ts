import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { sharedDocumentDigest, signSharedDocument, validateDeviceSecretIdentity, verifySharedDocument } from '../crypto.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import type { VerifiedPrivateCalendarAuthority } from '../private-calendar/authority.ts';
import { exactRecord, hexBytes, positiveInteger } from '../private-calendar/validation.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { canonicalJson } from '../operations.ts';
import { snapshotPrivatePlannerPreferences } from './preferences.ts';
import type { PrivatePlannerPreferences } from './preferences.ts';

export const PRIVATE_PREFERENCE_SUITE = 'liflow-private-planner-aes256gcm-hkdfsha256-ed25519-v1';
export const MAX_PRIVATE_PREFERENCE_ENVELOPE_CHARS = 24_000;
export interface PrivatePreferenceCursor { revision: number; digest: string }
export class PrivatePreferenceCloudConflict extends Error {
  readonly code = 'private-planner/conflict';
  constructor() { super('別の本人端末から設定が届いています。両方の内容を確認してください。'); this.name = 'PrivatePreferenceCloudConflict'; }
}
interface Header {
  schemaVersion: 1; suite: typeof PRIVATE_PREFERENCE_SUITE; ownerUserId: string; accountGeneration: string; rootDigest: string;
  authorityDigest: string; keyVersion: number; authorDeviceId: string; operationId: string;
  revision: number; parent: PrivatePreferenceCursor | null; salt: string; nonce: string;
}
export interface EncryptedPrivatePreferences { body: Header & { encryptedPayload: string }; signature: string }
const headerFields = ['schemaVersion', 'suite', 'ownerUserId', 'accountGeneration', 'rootDigest', 'authorityDigest', 'keyVersion',
  'authorDeviceId', 'operationId', 'revision', 'parent', 'salt', 'nonce'];
const encoder = new TextEncoder();
const utf8 = (value: unknown) => encoder.encode(canonicalJson(value));
export function snapshotPrivatePreferenceCursor(value: PrivatePreferenceCursor): PrivatePreferenceCursor {
  exactRecord(value, ['revision', 'digest']); positiveInteger(value.revision); hexBytes(value.digest, 32); return { ...value };
}
export function samePrivatePreferenceCursor(a: PrivatePreferenceCursor | null, b: PrivatePreferenceCursor | null): boolean {
  return a === null ? b === null : b !== null && a.revision === b.revision && a.digest === b.digest;
}
/** A bounded transport copy is not yet authenticated. Old generations may only match an already protected cursor. */
export function snapshotEncryptedPrivatePreferences(value: EncryptedPrivatePreferences): EncryptedPrivatePreferences {
  exactRecord(value, ['body', 'signature']); exactRecord(value.body, [...headerFields, 'encryptedPayload']); const b = value.body;
  if (b.schemaVersion !== 1 || b.suite !== PRIVATE_PREFERENCE_SUITE) throw new Error('本人設定の暗号方式を確認してください。');
  assertSharedIdentifier(b.ownerUserId); assertSharedIdentifier(b.authorDeviceId);
  [b.accountGeneration, b.rootDigest, b.authorityDigest, b.operationId, b.salt].forEach(value => hexBytes(value, 32));
  positiveInteger(b.keyVersion); positiveInteger(b.revision); hexBytes(b.nonce, 12); hexBytes(value.signature, 64);
  const parent = b.parent === null ? null : snapshotPrivatePreferenceCursor(b.parent);
  if (b.revision !== (parent?.revision ?? 0) + 1 || typeof b.encryptedPayload !== 'string' || b.encryptedPayload.length < 34
    || b.encryptedPayload.length > 20_000 || b.encryptedPayload.length % 2 || !/^[0-9a-f]+$/u.test(b.encryptedPayload)) throw new Error('本人設定の送信位置・暗号サイズが無効です。');
  const own = { body: { ...b, parent }, signature: value.signature };
  if (canonicalJson(own).length > MAX_PRIVATE_PREFERENCE_ENVELOPE_CHARS) throw new Error('本人設定の暗号サイズが大きすぎます。'); return own;
}
export function privatePreferenceCursor(encrypted: EncryptedPrivatePreferences): PrivatePreferenceCursor {
  const own = snapshotEncryptedPrivatePreferences(encrypted); return { revision: own.body.revision, digest: sharedDocumentDigest(own) };
}
export function verifyEncryptedPrivatePreferences(value: EncryptedPrivatePreferences, authority: VerifiedPrivateCalendarAuthority): EncryptedPrivatePreferences {
  const own = snapshotEncryptedPrivatePreferences(value); const b = own.body; const expected = authority.signed.body;
  const author = expected.devices.find(device => device.deviceId === b.authorDeviceId);
  if (b.ownerUserId !== expected.ownerUserId || b.accountGeneration !== expected.accountGeneration || b.rootDigest !== authority.anchor.rootDigest
    || b.authorityDigest !== authority.digest || b.keyVersion !== expected.keyVersion || !author) throw new Error('本人設定の承認端末・鍵の世代が異なります。');
  verifySharedDocument(b, own.signature, author); return own;
}
export async function sealPrivatePreferences(crypto: SharingCryptoGateway, input: { preferences: PrivatePlannerPreferences; authority: VerifiedPrivateCalendarAuthority;
  author: DeviceSecretIdentity; accountKey: Uint8Array; parent: PrivatePreferenceCursor | null }): Promise<EncryptedPrivatePreferences> {
  const preferences = snapshotPrivatePlannerPreferences(input.preferences); const author = validateDeviceSecretIdentity(input.author);
  const parent = input.parent === null ? null : snapshotPrivatePreferenceCursor(input.parent);
  if (input.accountKey.length !== 32 || !input.authority.signed.body.devices.some(device => device.deviceId === author.deviceId
    && device.signingPublicKey === author.signingPublicKey && device.agreementPublicKey === author.agreementPublicKey)) throw new Error('承認済みの本人端末で設定を送信してください。');
  const accountKey = input.accountKey.slice(); const plain = utf8(preferences); let key: Uint8Array | undefined;
  try {
    const operation = await crypto.randomBytes(32); const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
    if (operation.length !== 32 || salt.length !== 32 || nonce.length !== 12) throw new Error('安全な乱数を生成できません。');
    const a = input.authority; const header: Header = { schemaVersion: 1, suite: PRIVATE_PREFERENCE_SUITE, ownerUserId: a.signed.body.ownerUserId,
      accountGeneration: a.anchor.accountGeneration, rootDigest: a.anchor.rootDigest, authorityDigest: a.digest, keyVersion: a.signed.body.keyVersion,
      authorDeviceId: author.deviceId, operationId: bytesToHex(operation), revision: (parent?.revision ?? 0) + 1, parent, salt: bytesToHex(salt), nonce: bytesToHex(nonce) };
    const aad = utf8(header); key = hkdf(sha256, accountKey, salt, aad, 32);
    const encrypted = await crypto.encrypt(key, nonce, plain, aad);
    if (encrypted.length !== plain.length + 16) throw new Error('本人設定を暗号化できませんでした。');
    const body = { ...header, encryptedPayload: bytesToHex(encrypted) };
    return verifyEncryptedPrivatePreferences({ body, signature: signSharedDocument(body, author) }, a);
  } finally { accountKey.fill(0); plain.fill(0); key?.fill(0); }
}
export async function openPrivatePreferences(crypto: SharingCryptoGateway, value: EncryptedPrivatePreferences,
  authority: VerifiedPrivateCalendarAuthority, accountKey: Uint8Array): Promise<PrivatePlannerPreferences> {
  const own = verifyEncryptedPrivatePreferences(value, authority); if (accountKey.length !== 32) throw new Error('本人設定の鍵が無効です。');
  const { encryptedPayload, ...header } = own.body; const aad = utf8(header); const copy = accountKey.slice();
  const key = hkdf(sha256, copy, hexBytes(header.salt, 32), aad, 32); let plain: Uint8Array | undefined;
  try {
    plain = await crypto.decrypt(key, hexBytes(header.nonce, 12), hexBytes(encryptedPayload, encryptedPayload.length / 2), aad);
    if (plain.length !== encryptedPayload.length / 2 - 16) throw new Error('本人設定の復号結果を確認できません。');
    return snapshotPrivatePlannerPreferences(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)));
  } finally { copy.fill(0); key.fill(0); plain?.fill(0); }
}
