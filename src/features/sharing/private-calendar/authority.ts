import type { DevicePublicIdentity, DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { sharedDocumentDigest, signSharedDocument, validateDevicePublicIdentity, verifySharedDocument } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';
import { MAX_PRIVATE_CALENDAR_AUTHORITIES } from './authority-history-limits.ts';

export const PRIVATE_CALENDAR_AUTHORITY_SUITE = 'liflow-private-calendar-authority-v1';
export const MAX_PRIVATE_CALENDAR_DEVICES = 16;
export interface PrivateCalendarAuthorityChange { mainDeviceId: string; keyVersion: number; devices: DevicePublicIdentity[] }
export function snapshotPrivateCalendarAuthorityChange(change: PrivateCalendarAuthorityChange): PrivateCalendarAuthorityChange {
  exactRecord(change, ['mainDeviceId', 'keyVersion', 'devices']); assertSharedIdentifier(change.mainDeviceId); positiveInteger(change.keyVersion);
  if (!Array.isArray(change.devices) || !change.devices.length || change.devices.length > MAX_PRIVATE_CALENDAR_DEVICES) throw new Error('本人端末の一覧を確認してください。');
  return { ...change, devices: change.devices.map(validateDevicePublicIdentity) };
}
export interface PrivateCalendarAuthorityBody {
  schemaVersion: 1; suite: typeof PRIVATE_CALENDAR_AUTHORITY_SUITE;
  ownerUserId: string; accountGeneration: string; revision: number; keyVersion: number;
  mainDeviceId: string; devices: DevicePublicIdentity[]; previousDigest: string | null; signerDeviceId: string;
}
export interface SignedPrivateCalendarAuthority { body: PrivateCalendarAuthorityBody; signature: string }
export function samePrivateCalendarAuthorityConfiguration(before: Pick<PrivateCalendarAuthorityBody, 'mainDeviceId' | 'keyVersion' | 'devices'>,
  after: Pick<PrivateCalendarAuthorityBody, 'mainDeviceId' | 'keyVersion' | 'devices'>) {
  return before.mainDeviceId === after.mainDeviceId && before.keyVersion === after.keyVersion && sharedDocumentDigest(before.devices) === sharedDocumentDigest(after.devices);
}
/** Obtained locally at creation or through explicit pairing, never inferred from a cloud document. */
export interface PrivateCalendarTrustAnchor { ownerUserId: string; accountGeneration: string; rootDigest: string }
export interface PrivateCalendarKeyIssuer { deviceId: string; revision: number }
/** Keep this verified value in memory; re-verify a serialized chain against its local anchor. */
export interface VerifiedPrivateCalendarAuthority {
  readonly signed: SignedPrivateCalendarAuthority; readonly digest: string; readonly anchor: PrivateCalendarTrustAnchor;
  readonly signer: DevicePublicIdentity;
  /** Derived from the signed transition that created this key version, never from the current main alone. */
  readonly keyIssuer: PrivateCalendarKeyIssuer | null;
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
function verified(signed: SignedPrivateCalendarAuthority, anchor: PrivateCalendarTrustAnchor, signer: DevicePublicIdentity, keyIssuer: PrivateCalendarKeyIssuer | null): VerifiedPrivateCalendarAuthority {
  // Do not retain mutable objects supplied by a caller or transport.
  const copy = { body: { ...signed.body, devices: signed.body.devices.map((device) => ({ ...device })) }, signature: signed.signature };
  copy.body.devices.forEach(Object.freeze); Object.freeze(copy.body.devices); Object.freeze(copy.body); Object.freeze(copy);
  return Object.freeze({ signed: copy, digest: sharedDocumentDigest(copy), anchor: Object.freeze({ ...anchor }), signer: Object.freeze({ ...signer }),
    keyIssuer: keyIssuer ? Object.freeze({ ...keyIssuer }) : null });
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
  return verified(signed, anchor, body.devices[0], { deviceId: body.mainDeviceId, revision: 1 });
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
  if (samePrivateCalendarAuthorityConfiguration(before, body) && body.signerDeviceId !== before.mainDeviceId) throw new Error('取得元の更新は現在のメイン端末からだけ受け付けます。');
  const removed = before.devices.some((device) => !body.devices.some((next) => next.deviceId === device.deviceId));
  if (body.keyVersion !== before.keyVersion && body.keyVersion !== before.keyVersion + 1
    || (removed && body.keyVersion !== before.keyVersion + 1)) throw new Error('端末解除には本人用の新しい鍵が必要です。');
  verifySharedDocument(body, signed.signature, signer);
  return verified(signed, previous.anchor, signer, body.keyVersion === before.keyVersion ? previous.keyIssuer : { deviceId: body.mainDeviceId, revision: body.revision });
}

export interface ProtectedPrivateCalendarCheckpoint {
  signed: SignedPrivateCalendarAuthority; signer: DevicePublicIdentity;
  /** Optional only for readable checkpoints saved by the earlier private Calendar prototype. */
  keyIssuer?: PrivateCalendarKeyIssuer | null;
}
/** Only for a previously verified checkpoint read from protected local storage. Never accept this object from Cloud. */
export function privateCalendarAuthorityFromProtectedCheckpoint(checkpoint: ProtectedPrivateCalendarCheckpoint, anchor: PrivateCalendarTrustAnchor): VerifiedPrivateCalendarAuthority {
  const fields = ['signed', 'signer']; if (checkpoint && typeof checkpoint === 'object' && Object.hasOwn(checkpoint, 'keyIssuer')) fields.push('keyIssuer');
  exactRecord(checkpoint, fields); exactRecord(checkpoint.signer, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  exactRecord(anchor, ['ownerUserId', 'accountGeneration', 'rootDigest']); assertSharedIdentifier(anchor.ownerUserId);
  hexBytes(anchor.accountGeneration, 32); hexBytes(anchor.rootDigest, 32);
  const signed = snapshotPrivateCalendarAuthority(checkpoint.signed); const signer = validateDevicePublicIdentity(checkpoint.signer);
  if (signed.body.ownerUserId !== anchor.ownerUserId || signed.body.accountGeneration !== anchor.accountGeneration
    || signed.body.signerDeviceId !== signer.deviceId || signed.body.keyVersion > signed.body.revision
    || signed.body.revision > 1 && signed.body.previousDigest === null) throw new Error('本人用の保存済み認証情報が一致しません。');
  const keyIssuer = checkpoint.keyIssuer ?? null;
  if (keyIssuer !== null) {
    exactRecord(keyIssuer, ['deviceId', 'revision']); assertSharedIdentifier(keyIssuer.deviceId); positiveInteger(keyIssuer.revision);
    if (keyIssuer.revision < signed.body.keyVersion || keyIssuer.revision > signed.body.revision
      || !signed.body.devices.some((device) => device.deviceId === keyIssuer.deviceId)) throw new Error('本人用の鍵生成元を確認できません。');
  }
  if (signed.body.revision === 1) {
    if (keyIssuer && (keyIssuer.deviceId !== signed.body.mainDeviceId || keyIssuer.revision !== 1)) throw new Error('本人用の初回鍵生成元が異なります。');
    return verifyPrivateCalendarRoot(signed, anchor);
  }
  verifySharedDocument(signed.body, signed.signature, signer);
  return verified(signed, anchor, signer, keyIssuer);
}
/** The caller must obtain explicit device-management or Calendar-source confirmation before signing. */
export function advancePrivateCalendarAuthority(previous: VerifiedPrivateCalendarAuthority, change: {
  mainDeviceId: string; devices: readonly DevicePublicIdentity[]; keyVersion: number;
}, signer: DeviceSecretIdentity, options?: { purpose: 'calendarSourceChange' }): VerifiedPrivateCalendarAuthority {
  if (options && (Object.keys(options).join(',') !== 'purpose' || options.purpose !== 'calendarSourceChange')) throw new Error('本人端末の変更目的が無効です。');
  const selected = snapshotPrivateCalendarAuthorityChange({ ...change, devices: [...change.devices] });
  const body: PrivateCalendarAuthorityBody = { ...previous.signed.body, ...change,
    devices: selected.devices.sort((a, b) => a.deviceId < b.deviceId ? -1 : a.deviceId > b.deviceId ? 1 : 0),
    revision: previous.signed.body.revision + 1, previousDigest: previous.digest, signerDeviceId: signer.deviceId };
  const unchanged = samePrivateCalendarAuthorityConfiguration(body, previous.signed.body);
  if (unchanged && !options) {
    const registered = previous.signed.body.devices.find(device => device.deviceId === signer.deviceId);
    if (!registered) throw new Error('未承認・解除済みの本人端末からの変更です。');
    verifySharedDocument(body, signSharedDocument(body, signer), registered); return previous;
  }
  if ((options || !unchanged) && body.revision > MAX_PRIVATE_CALENDAR_AUTHORITIES) throw new Error('本人端末の署名履歴が上限に達しています。既存の設定は保持しています。');
  if (options) {
    // Source changes advance only the cache epoch, without relabelling a key generation or changing devices.
    if (!unchanged || signer.deviceId !== previous.signed.body.mainDeviceId) throw new Error('取得元の更新はメイン端末で行い、端末や鍵の変更と分けてください。');
  }
  return verifyPrivateCalendarAuthorityUpdate(previous, { body, signature: signSharedDocument(body, signer) });
}
