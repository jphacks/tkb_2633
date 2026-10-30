import { assertJsonRecord, assertSharedIdentifier, canonicalJson } from '../operations.ts';
import type { EncryptedSharedSnapshotChunk } from '../crypto.ts';
import { validateV2RecoveryLock } from './recovery-lock.ts';
import type { SignedV2RecoveryLock } from './recovery-lock.ts';

/** Only ciphertext and delivery/key metadata leave the device. History digests stay inside the ciphertext. */
export interface V2RecoveryCloudRecord {
  schemaVersion: 1; snapshotId: string; previousKeyVersion: number; keyVersion: number; throughSequence: number;
  lockId: string; reviewDigest: string; encryptedHeaderJson: string;
}
export interface V2RecoveryQuarantineRecord {
  schemaVersion: 1; operationId: string; recoveryId: string; uploadSequence: number; keyVersion: number; rawDigest: string;
}
export function validateV2RecoveryCloudRecord(raw: V2RecoveryCloudRecord, groupId: string): V2RecoveryCloudRecord {
  assertJsonRecord(raw); assertSharedIdentifier(groupId);
  if (Object.keys(raw).sort().join(',') !== 'encryptedHeaderJson,keyVersion,lockId,previousKeyVersion,reviewDigest,schemaVersion,snapshotId,throughSequence'
    || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.previousKeyVersion) || raw.previousKeyVersion < 1 || raw.keyVersion !== raw.previousKeyVersion + 1
    || !Number.isSafeInteger(raw.throughSequence) || raw.throughSequence < 1 || !/^[a-f0-9]{64}$/u.test(raw.reviewDigest)
    || typeof raw.encryptedHeaderJson !== 'string' || raw.encryptedHeaderJson.length > 800_000) throw new Error('Invalid encrypted recovery record');
  [raw.snapshotId, raw.lockId].forEach(assertSharedIdentifier);
  const encrypted = JSON.parse(raw.encryptedHeaderJson) as EncryptedSharedSnapshotChunk;
  assertJsonRecord(encrypted);
  if (Object.keys(encrypted).sort().join(',') !== 'chunkIndex,encryptedPayload,groupId,keyVersion,nonce,ownerDeviceId,salt,schemaVersion,signature,snapshotId,suite'
    || encrypted.schemaVersion !== 1 || encrypted.suite !== 'liflow-snapshot-aes256gcm-hkdfsha256-ed25519-v1'
    || !/^[a-f0-9]{64}$/u.test(encrypted.salt) || !/^[a-f0-9]{24}$/u.test(encrypted.nonce) || !/^[a-f0-9]{128}$/u.test(encrypted.signature)
    || typeof encrypted.encryptedPayload !== 'string' || !/^(?:[a-f0-9]{2})+$/u.test(encrypted.encryptedPayload)
    || encrypted.encryptedPayload.length > (320 * 1024 + 16) * 2) throw new Error('Invalid encrypted recovery header');
  assertSharedIdentifier(encrypted.ownerDeviceId);
  if (encrypted.groupId !== groupId || encrypted.snapshotId !== `recovery-proof.${raw.snapshotId}` || encrypted.keyVersion !== raw.keyVersion
    || encrypted.chunkIndex !== 0) throw new Error('Encrypted recovery record context changed');
  return JSON.parse(canonicalJson(raw));
}
export function recoveryRecordMatchesLock(record: V2RecoveryCloudRecord, rawLock: SignedV2RecoveryLock) {
  const lock = validateV2RecoveryLock(rawLock);
  validateV2RecoveryCloudRecord(record, lock.body.groupId);
  if (record.lockId !== lock.body.id || record.previousKeyVersion !== lock.body.keyVersion || record.throughSequence !== lock.body.throughSequence
    || record.reviewDigest !== lock.body.reviewDigest) throw new Error('Recovery record differs from the confirmed lock');
}
export function validateV2RecoveryQuarantine(raw: V2RecoveryQuarantineRecord): V2RecoveryQuarantineRecord {
  assertJsonRecord(raw);
  if (Object.keys(raw).sort().join(',') !== 'keyVersion,operationId,rawDigest,recoveryId,schemaVersion,uploadSequence'
    || raw.schemaVersion !== 1 || !Number.isSafeInteger(raw.keyVersion) || raw.keyVersion < 1 || !Number.isSafeInteger(raw.uploadSequence) || raw.uploadSequence < 1
    || !/^[a-f0-9]{64}$/u.test(raw.rawDigest)) throw new Error('Invalid immutable quarantine record');
  [raw.operationId, raw.recoveryId].forEach(assertSharedIdentifier);
  return JSON.parse(canonicalJson(raw));
}
