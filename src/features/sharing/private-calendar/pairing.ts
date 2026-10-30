import type { DevicePublicIdentity, DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { sharedDocumentDigest, signSharedDocument, validateDevicePublicIdentity, validateDeviceSecretIdentity, verifySharedDocument } from '../crypto.ts';
import type { PrivateCalendarTrustAnchor, VerifiedPrivateCalendarAuthority } from './authority.ts';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface PrivateCalendarPairingReference { anchor: PrivateCalendarTrustAnchor; authorityDigest: string; authorityRevision: number }
const SUITE = 'liflow-private-calendar-pairing-request-v1';
export interface PrivateCalendarPairingRequest {
  body: { schemaVersion: 1; suite: typeof SUITE; ownerUserId: string; accountGeneration: string; rootDigest: string;
    authorityDigest: string; authorityRevision: number; requestNonce: string; device: DevicePublicIdentity };
  signature: string;
}
export function snapshotPrivateCalendarPairingReference(reference: PrivateCalendarPairingReference): PrivateCalendarPairingReference {
  exactRecord(reference, ['anchor', 'authorityDigest', 'authorityRevision']); exactRecord(reference.anchor, ['ownerUserId', 'accountGeneration', 'rootDigest']);
  assertSharedIdentifier(reference.anchor.ownerUserId); hexBytes(reference.anchor.accountGeneration, 32); hexBytes(reference.anchor.rootDigest, 32);
  hexBytes(reference.authorityDigest, 32); positiveInteger(reference.authorityRevision);
  return { anchor: { ...reference.anchor }, authorityDigest: reference.authorityDigest, authorityRevision: reference.authorityRevision };
}
/** Pass to the other device through an explicitly confirmed out-of-band channel, never infer it from Cloud. */
export function privateCalendarPairingReference(authority: VerifiedPrivateCalendarAuthority): PrivateCalendarPairingReference {
  return snapshotPrivateCalendarPairingReference({ anchor: authority.anchor, authorityDigest: authority.digest, authorityRevision: authority.signed.body.revision });
}
export function verifyPrivateCalendarPairingRequest(request: PrivateCalendarPairingRequest): PrivateCalendarPairingRequest {
  exactRecord(request, ['body', 'signature']);
  exactRecord(request.body, ['schemaVersion', 'suite', 'ownerUserId', 'accountGeneration', 'rootDigest', 'authorityDigest', 'authorityRevision', 'requestNonce', 'device']);
  const body = request.body; if (body.schemaVersion !== 1 || body.suite !== SUITE) throw new Error('本人端末の確認依頼の形式が異なります。');
  const reference = snapshotPrivateCalendarPairingReference({ anchor: { ownerUserId: body.ownerUserId, accountGeneration: body.accountGeneration, rootDigest: body.rootDigest },
    authorityDigest: body.authorityDigest, authorityRevision: body.authorityRevision });
  hexBytes(body.requestNonce, 32); hexBytes(request.signature, 64); exactRecord(body.device, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  const device = validateDevicePublicIdentity(body.device); const signed = { body: { ...body, ...reference.anchor, device }, signature: request.signature };
  verifySharedDocument(signed.body, signed.signature, device); return signed;
}
export async function createPrivateCalendarPairingRequest(crypto: SharingCryptoGateway, reference: PrivateCalendarPairingReference, identity: DeviceSecretIdentity): Promise<PrivateCalendarPairingRequest> {
  const owned = snapshotPrivateCalendarPairingReference(reference); identity = validateDeviceSecretIdentity(identity);
  const nonce = await crypto.randomBytes(32); if (nonce.length !== 32) throw new Error('本人端末の確認用の乱数を生成できません。');
  const body: PrivateCalendarPairingRequest['body'] = { schemaVersion: 1, suite: SUITE, ...owned.anchor, authorityDigest: owned.authorityDigest,
    authorityRevision: owned.authorityRevision, requestNonce: bytesToHex(nonce), device: validateDevicePublicIdentity(identity) };
  return verifyPrivateCalendarPairingRequest({ body, signature: signSharedDocument(body, identity) });
}
/** A request is bound to the displayed authority; replay after a removal or any intervening change cannot reapprove it. */
export function privateCalendarPairingApproval(request: PrivateCalendarPairingRequest, current: VerifiedPrivateCalendarAuthority) {
  const owned = verifyPrivateCalendarPairingRequest(request); const body = owned.body;
  if (body.ownerUserId !== current.anchor.ownerUserId || body.accountGeneration !== current.anchor.accountGeneration || body.rootDigest !== current.anchor.rootDigest
    || body.authorityDigest !== current.digest || body.authorityRevision !== current.signed.body.revision) throw new Error('表示した本人端末の設定が更新されています。新しい確認依頼を交換してください。');
  return { requestDigest: sharedDocumentDigest(owned), device: owned.body.device,
    change: { devices: [...current.signed.body.devices.filter(device => device.deviceId !== body.device.deviceId), body.device],
      mainDeviceId: current.signed.body.mainDeviceId, keyVersion: current.signed.body.keyVersion } };
}
