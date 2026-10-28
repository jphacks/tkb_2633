import type { DevicePublicIdentity, DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { sharedDocumentDigest, signSharedDocument, validateDevicePublicIdentity, verifySharedDocument } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';

export const PRIVATE_CALENDAR_AUTHORITY_SUITE = 'liflow-private-calendar-authority-v1';
export const MAX_PRIVATE_CALENDAR_DEVICES = 16;
export interface PrivateCalendarAuthorityBody {
  schemaVersion: 1; suite: typeof PRIVATE_CALENDAR_AUTHORITY_SUITE;
  ownerUserId: string; accountGeneration: string; revision: number; keyVersion: number;
  mainDeviceId: string; devices: DevicePublicIdentity[]; previousDigest: string | null; signerDeviceId: string;
}
export interface SignedPrivateCalendarAuthority { body: PrivateCalendarAuthorityBody; signature: string }
/** Obtained locally at creation or through explicit pairing, never inferred from a cloud document. */
export interface PrivateCalendarTrustAnchor { ownerUserId: string; accountGeneration: string; rootDigest: string }
/** Keep this verified value in memory; re-verify a serialized chain against its local anchor. */
export interface VerifiedPrivateCalendarAuthority {
  readonly signed: SignedPrivateCalendarAuthority; readonly digest: string; readonly anchor: PrivateCalendarTrustAnchor;
  readonly signer: DevicePublicIdentity;
}

/** Bounds and copies transport input; this alone does not verify its authority. */
export function snapshotPrivateCalendarAuthority(value: SignedPrivateCalendarAuthority): SignedPrivateCalendarAuthority {
  exactRecord(value, ['body', 'signature']);
  exactRecord(value.body, ['schemaVersion', 'suite', 'ownerUserId', 'accountGeneration', 'revision', 'keyVersion', 'mainDeviceId', 'devices', 'previousDigest', 'signerDeviceId']);
  const body = value.body;
  if (body.schemaVersion !== 1 || body.suite !== PRIVATE_CALENDAR_AUTHORITY_SUITE) throw new Error('本人用Calendarの認証形式が異なります。');
  for (const key of ['ownerUserId', 'accountGeneration', 'mainDeviceId', 'signerDeviceId'] as const) assertSharedIdentifier(body[key]);
  hexBytes(body.accountGeneration, 32);
  positiveInteger(body.revision); positiveInteger(body.keyVersion); hexBytes(value.signature, 64);
  if (body.previousDigest !== null) hexBytes(body.previousDigest, 32);
  if (!Array.isArray(body.devices) || !body.devices.length || body.devices.length > MAX_PRIVATE_CALENDAR_DEVICES) throw new Error('本人用端末の数が無効です。');
  const devices = body.devices.map((device) => {
    exactRecord(device, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
    return validateDevicePublicIdentity(device);
  });
  if (devices.some((device, index) => index > 0 && devices[index - 1].deviceId >= device.deviceId)
    || !devices.some((device) => device.deviceId === body.mainDeviceId)) throw new Error('本人用端末の登録が無効です。');
  return { body: { ...body, devices }, signature: value.signature };
}
function verified(signed: SignedPrivateCalendarAuthority, anchor: PrivateCalendarTrustAnchor, signer: DevicePublicIdentity): VerifiedPrivateCalendarAuthority {
  // Do not retain mutable objects supplied by a caller or transport.
  const copy = { body: { ...signed.body, devices: signed.body.devices.map((device) => ({ ...device })) }, signature: signed.signature };
  copy.body.devices.forEach(Object.freeze); Object.freeze(copy.body.devices); Object.freeze(copy.body); Object.freeze(copy);
  return Object.freeze({ signed: copy, digest: sharedDocumentDigest(copy), anchor: Object.freeze({ ...anchor }), signer: Object.freeze({ ...signer }) });
}
export function verifyPrivateCalendarRoot(value: SignedPrivateCalendarAuthority, anchor: PrivateCalendarTrustAnchor): VerifiedPrivateCalendarAuthority {
  exactRecord(anchor, ['ownerUserId', 'accountGeneration', 'rootDigest']);
  assertSharedIdentifier(anchor.ownerUserId); hexBytes(anchor.accountGeneration, 32); hexBytes(anchor.rootDigest, 32);
  const signed = snapshotPrivateCalendarAuthority(value); const body = signed.body;
  if (body.ownerUserId !== anchor.ownerUserId || body.accountGeneration !== anchor.accountGeneration
    || body.revision !== 1 || body.keyVersion !== 1 || body.previousDigest !== null || body.devices.length !== 1
    || body.mainDeviceId !== body.signerDeviceId || body.devices[0].deviceId !== body.signerDeviceId
    || sharedDocumentDigest(signed) !== anchor.rootDigest) throw new Error('本人端末で確認した信頼情報と一致しません。');
  verifySharedDocument(body, signed.signature, body.devices[0]);
  return verified(signed, anchor, body.devices[0]);
}
/** Call only for an explicit first-device setup, never as an automatic replacement for missing keys. */
export async function createPrivateCalendarRoot(crypto: SharingCryptoGateway, ownerUserId: string, device: DeviceSecretIdentity): Promise<VerifiedPrivateCalendarAuthority> {
  assertSharedIdentifier(ownerUserId);
  const generation = await crypto.randomBytes(32); if (generation.length !== 32) throw new Error('安全な乱数を生成できません。');
  const body: PrivateCalendarAuthorityBody = { schemaVersion: 1, suite: PRIVATE_CALENDAR_AUTHORITY_SUITE, ownerUserId,
    accountGeneration: bytesToHex(generation), revision: 1, keyVersion: 1, mainDeviceId: device.deviceId,
    devices: [validateDevicePublicIdentity(device)], previousDigest: null, signerDeviceId: device.deviceId };
  const signed = { body, signature: signSharedDocument(body, device) };
  return verifyPrivateCalendarRoot(signed, { ownerUserId, accountGeneration: body.accountGeneration, rootDigest: sharedDocumentDigest(signed) });
}
export function verifyPrivateCalendarAuthorityUpdate(previous: VerifiedPrivateCalendarAuthority, value: SignedPrivateCalendarAuthority): VerifiedPrivateCalendarAuthority {
  const signed = snapshotPrivateCalendarAuthority(value); const before = previous.signed.body; const body = signed.body;
  if (body.ownerUserId !== before.ownerUserId || body.accountGeneration !== before.accountGeneration
    || body.revision !== before.revision + 1 || body.previousDigest !== previous.digest) throw new Error('本人端末の設定が更新されています。再読込して確認してください。');
  const signer = before.devices.find((device) => device.deviceId === body.signerDeviceId);
  if (!signer) throw new Error('未承認・解除済みの本人端末からの変更です。');
  const removed = before.devices.some((device) => !body.devices.some((next) => next.deviceId === device.deviceId));
  if (body.keyVersion !== before.keyVersion && body.keyVersion !== before.keyVersion + 1
    || (removed && body.keyVersion !== before.keyVersion + 1)) throw new Error('端末解除には本人用の新しい鍵が必要です。');
  verifySharedDocument(body, signed.signature, signer);
  return verified(signed, previous.anchor, signer);
}

export interface ProtectedPrivateCalendarCheckpoint { signed: SignedPrivateCalendarAuthority; signer: DevicePublicIdentity }
/** Only for a previously verified checkpoint read from protected local storage. Never accept this object from Cloud. */
export function privateCalendarAuthorityFromProtectedCheckpoint(checkpoint: ProtectedPrivateCalendarCheckpoint, anchor: PrivateCalendarTrustAnchor): VerifiedPrivateCalendarAuthority {
  exactRecord(checkpoint, ['signed', 'signer']); exactRecord(checkpoint.signer, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  exactRecord(anchor, ['ownerUserId', 'accountGeneration', 'rootDigest']); assertSharedIdentifier(anchor.ownerUserId);
  hexBytes(anchor.accountGeneration, 32); hexBytes(anchor.rootDigest, 32);
  const signed = snapshotPrivateCalendarAuthority(checkpoint.signed); const signer = validateDevicePublicIdentity(checkpoint.signer);
  if (signed.body.ownerUserId !== anchor.ownerUserId || signed.body.accountGeneration !== anchor.accountGeneration
    || signed.body.signerDeviceId !== signer.deviceId || signed.body.keyVersion > signed.body.revision
    || signed.body.revision > 1 && signed.body.previousDigest === null) throw new Error('本人用の保存済み認証情報が一致しません。');
  if (signed.body.revision === 1) return verifyPrivateCalendarRoot(signed, anchor);
  verifySharedDocument(signed.body, signed.signature, signer);
  return verified(signed, anchor, signer);
}
/** The caller must obtain explicit pairing/main-device/revocation confirmation before signing. */
export function advancePrivateCalendarAuthority(previous: VerifiedPrivateCalendarAuthority, change: {
  mainDeviceId: string; devices: readonly DevicePublicIdentity[]; keyVersion: number;
}, signer: DeviceSecretIdentity): VerifiedPrivateCalendarAuthority {
  const body: PrivateCalendarAuthorityBody = { ...previous.signed.body, ...change,
    devices: change.devices.map((device) => validateDevicePublicIdentity(device)).sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0),
    revision: previous.signed.body.revision + 1, previousDigest: previous.digest, signerDeviceId: signer.deviceId };
  const next = verifyPrivateCalendarAuthorityUpdate(previous, { body, signature: signSharedDocument(body, signer) });
  const configuration = (value: PrivateCalendarAuthorityBody) => sharedDocumentDigest({ mainDeviceId: value.mainDeviceId, devices: value.devices, keyVersion: value.keyVersion });
  return configuration(body) === configuration(previous.signed.body) ? previous : next;
}
