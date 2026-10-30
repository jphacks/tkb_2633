import { openSharedSnapshotChunk, sealSharedSnapshotChunk, sharedDocumentDigest, signSharedDocument } from '../crypto.ts';
import type { DeviceSecretIdentity, EncryptedSharedSnapshotChunk, SharingCryptoGateway } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { sharedAuthorIdentity } from '../roster.ts';
import { validateV2RecoveryHeader, verifyV2RecoveryHeader } from './recovery-witness.ts';
import type { SignedV2RecoveryHeader } from './recovery-witness.ts';

const purposeId = (snapshotId: string) => `recovery-proof.${snapshotId}`;

/** Hash a hidden owner proof, rather than publishing a dictionary-testable digest of private history. */
export function v2RecoveryReviewDigest(review: unknown, owner: DeviceSecretIdentity): string {
  return sharedDocumentDigest({ proof: signSharedDocument({ domain: 'liflow-v2-owner-private-review-v1', review }, owner) });
}

/** Recovery metadata contains private history digests; keep the signed header encrypted in the cloud too. */
export async function sealV2RecoveryHeader(crypto: SharingCryptoGateway, raw: SignedV2RecoveryHeader,
  key: Uint8Array, owner: DeviceSecretIdentity): Promise<EncryptedSharedSnapshotChunk> {
  const header = validateV2RecoveryHeader(raw); const { body } = header;
  if (body.ownerDeviceId !== owner.deviceId) throw new Error('Recovery encryption owner mismatch');
  return sealSharedSnapshotChunk(crypto, new TextEncoder().encode(canonicalJson(header)),
    { groupId: body.groupId, snapshotId: purposeId(body.snapshotId), chunkIndex: 0, keyVersion: body.keyVersion }, key, owner);
}

export async function openV2RecoveryHeader(crypto: SharingCryptoGateway, encrypted: EncryptedSharedSnapshotChunk,
  key: Uint8Array, archive: readonly VerifiedSharedRoster[], expected: { groupId: string; snapshotId: string; keyVersion: number }): Promise<SignedV2RecoveryHeader> {
  const epoch = archive[expected.keyVersion - 1];
  if (!epoch || epoch.body.groupId !== expected.groupId || epoch.body.keyVersion !== expected.keyVersion || epoch.body.schemaVersion !== 2) throw new Error('Missing recovery encryption membership');
  const owner = sharedAuthorIdentity(epoch, epoch.body.ownerUserId, epoch.body.ownerDeviceId, epoch.body.keyVersion);
  const plaintext = await openSharedSnapshotChunk(crypto, encrypted, { ...expected, snapshotId: purposeId(expected.snapshotId), chunkIndex: 0 }, key, owner);
  const header = verifyV2RecoveryHeader(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plaintext)), archive, expected.groupId);
  if (header.body.snapshotId !== expected.snapshotId || header.body.keyVersion !== expected.keyVersion) throw new Error('Recovery header context changed');
  return header;
}
