import { assertJsonRecord, assertSharedIdentifier, canonicalJson, validateSharedOperation } from '../operations.ts';
import { sharedDocumentDigest, signSharedDocument, verifyAuthenticatedSharedOperation, verifySharedDocument } from '../crypto.ts';
import type { AuthenticatedSharedOperation, DeviceSecretIdentity } from '../crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterTransition } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';

export const MAX_V2_RECOVERY_ENTRIES = 256;
export const MAX_V2_RECOVERY_WITNESSES = 64;
export type V2RecoveryClassification = 'invalidEnvelope' | 'invalidAuthentication' | 'missingReceipt' | 'blockedCausality' | 'restoredOriginal';
export interface V2RecoveryEntry {
  operationId: string; uploadSequence: number; authorUserId: string; authorDeviceId: string; keyVersion: number;
  rawDigest: string; receiptDigest: string | null; classification: V2RecoveryClassification; preservedFactDigest: string | null;
}
export interface V2RecoveryPreservedFact { fact: AuthenticatedSharedOperation; receipt: V2ServerReceipt }
export interface V2RecoveryWitnessBody {
  schemaVersion: 1; groupId: string; snapshotId: string; ownerUserId: string; ownerDeviceId: string;
  previousRosterDigest: string; nextRosterDigest: string; previousKeyVersion: number; keyVersion: number;
  baselineSequence: number; throughSequence: number; baselineIndexDigest: string; retainedIndexDigest: string;
  reviewDigest: string; entries: V2RecoveryEntry[];
}
export interface SignedV2RecoveryHeader { body: V2RecoveryWitnessBody; signature: string }
export interface SignedV2RecoveryWitness extends SignedV2RecoveryHeader { preservedFacts: V2RecoveryPreservedFact[] }
const domain = 'liflow-v2-owner-recovery-v1';
const hex = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
const number = (value: unknown, minimum = 0): value is number => Number.isSafeInteger(value) && (value as number) >= minimum;
function exact(value: unknown, keys: string[]) {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Unknown recovery evidence field');
}

/** Bounded wire parsing, independent of the owner's authority and signature check. */
export function validateV2RecoveryHeader(input: SignedV2RecoveryHeader): SignedV2RecoveryHeader {
  exact(input, ['body', 'signature']);
  const { body } = input;
  exact(body, ['schemaVersion', 'groupId', 'snapshotId', 'ownerUserId', 'ownerDeviceId', 'previousRosterDigest', 'nextRosterDigest',
    'previousKeyVersion', 'keyVersion', 'baselineSequence', 'throughSequence', 'baselineIndexDigest', 'retainedIndexDigest', 'reviewDigest', 'entries']);
  if (body.schemaVersion !== 1 || !number(body.previousKeyVersion, 1) || body.keyVersion !== body.previousKeyVersion + 1
    || !number(body.baselineSequence) || !number(body.throughSequence) || body.throughSequence <= body.baselineSequence
    || ![body.previousRosterDigest, body.nextRosterDigest, body.baselineIndexDigest, body.retainedIndexDigest, body.reviewDigest].every(hex)
    || typeof input.signature !== 'string' || !/^[a-f0-9]{128}$/u.test(input.signature)
    || !Array.isArray(body.entries) || !body.entries.length || body.entries.length > MAX_V2_RECOVERY_ENTRIES) throw new Error('Invalid recovery evidence');
  for (const id of [body.groupId, body.snapshotId, body.ownerUserId, body.ownerDeviceId]) assertSharedIdentifier(id);
  const ids = new Set<string>(); let sequence = body.baselineSequence;
  for (const entry of body.entries) {
    exact(entry, ['operationId', 'uploadSequence', 'authorUserId', 'authorDeviceId', 'keyVersion', 'rawDigest', 'receiptDigest', 'classification', 'preservedFactDigest']);
    for (const id of [entry.operationId, entry.authorUserId, entry.authorDeviceId]) assertSharedIdentifier(id);
    if (ids.has(entry.operationId) || !number(entry.uploadSequence, 1) || entry.uploadSequence <= sequence
      || entry.uploadSequence > body.throughSequence || entry.keyVersion !== body.previousKeyVersion
      || !hex(entry.rawDigest) || entry.receiptDigest !== null && !hex(entry.receiptDigest)
      || !['invalidEnvelope', 'invalidAuthentication', 'missingReceipt', 'blockedCausality', 'restoredOriginal'].includes(entry.classification)
      || (['blockedCausality', 'restoredOriginal'].includes(entry.classification) ? !hex(entry.preservedFactDigest) || !hex(entry.receiptDigest) : entry.preservedFactDigest !== null)) {
      throw new Error('Invalid or duplicate quarantined event');
    }
    ids.add(entry.operationId); sequence = entry.uploadSequence;
  }
  if (new TextEncoder().encode(canonicalJson(input)).length > 240 * 1024) throw new Error('Recovery header exceeds the snapshot record limit');
  return JSON.parse(canonicalJson(input));
}

export function validateV2RecoveryWitness(input: SignedV2RecoveryWitness): SignedV2RecoveryWitness {
  exact(input, ['body', 'signature', 'preservedFacts']);
  const { body } = validateV2RecoveryHeader({ body: input.body, signature: input.signature });
  if (!Array.isArray(input.preservedFacts) || input.preservedFacts.length > body.entries.length) throw new Error('Invalid preserved recovery facts');
  const held = new Map(body.entries.filter(entry => entry.preservedFactDigest !== null).map(entry => [entry.operationId, entry]));
  if (held.size !== input.preservedFacts.length) throw new Error('Recovery lost a preserved original fact');
  const facts = new Set<string>();
  for (const value of input.preservedFacts) {
    exact(value, ['fact', 'receipt']); exact(value.fact, ['operation', 'authorSignature']);
    const operation = validateSharedOperation(value.fact.operation, body.groupId); const entry = held.get(operation.operationId);
    if (operation.schemaVersion !== 2 || !entry || facts.has(operation.operationId) || sharedDocumentDigest(value) !== entry.preservedFactDigest
      || sharedDocumentDigest(value.receipt) !== entry.receiptDigest || value.receipt.uploadSequence !== entry.uploadSequence
      || operation.authorUserId !== entry.authorUserId || operation.authorDeviceId !== entry.authorDeviceId) throw new Error('Recovery held fact does not match its signed digest');
    facts.add(operation.operationId);
  }
  return JSON.parse(canonicalJson(input));
}

export function signV2RecoveryWitness(body: V2RecoveryWitnessBody, preservedFacts: V2RecoveryPreservedFact[], owner: DeviceSecretIdentity): SignedV2RecoveryWitness {
  if (body.ownerDeviceId !== owner.deviceId) throw new Error('Recovery signing device mismatch');
  return validateV2RecoveryWitness({ body, signature: signSharedDocument({ domain, body }, owner), preservedFacts });
}

/** A pinned roster archive, not a server supplied "owner" field, authorizes recovery. */
export function verifyV2RecoveryHeader(input: SignedV2RecoveryHeader, archive: readonly VerifiedSharedRoster[], groupId: string) {
  const header = validateV2RecoveryHeader(input); const { body } = header;
  const previous = archive[body.previousKeyVersion - 1]; const next = archive[body.keyVersion - 1];
  if (body.groupId !== groupId || !previous || !next || sharedRosterDigest(previous) !== body.previousRosterDigest || sharedRosterDigest(next) !== body.nextRosterDigest
    || body.previousKeyVersion !== previous.body.keyVersion || body.keyVersion !== next.body.keyVersion
    || previous.body.schemaVersion !== 2 || next.body.schemaVersion !== 2 || previous.body.groupId !== groupId || next.body.groupId !== groupId || next.body.closed
    || previous.body.ownerUserId !== body.ownerUserId || previous.body.ownerDeviceId !== body.ownerDeviceId
    || next.body.ownerUserId !== body.ownerUserId || next.body.ownerDeviceId !== body.ownerDeviceId) throw new Error('Untrusted recovery owner or membership epoch');
  verifySharedRosterTransition(previous, next);
  const priorDevices = new Map(previous.body.members.flatMap(member => member.devices.map(device => [device.identity.deviceId, member.userId])));
  if (next.body.members.some(member => member.devices.some(device => priorDevices.get(device.identity.deviceId) !== member.userId))) throw new Error('Recovery cannot add or transfer a device');
  const owner = sharedAuthorIdentity(previous, body.ownerUserId, body.ownerDeviceId, body.previousKeyVersion);
  verifySharedDocument({ domain, body }, header.signature, owner);
  const retainedDevices = new Set(next.body.members.flatMap(member => member.devices.map(device => device.identity.deviceId)));
  for (const entry of body.entries) {
    sharedAuthorIdentity(previous, entry.authorUserId, entry.authorDeviceId, entry.keyVersion);
    if (entry.classification !== 'restoredOriginal' && retainedDevices.has(entry.authorDeviceId)) throw new Error('Recovery must revoke an unresolved author device before resuming delivery');
  }
  return header;
}

export function verifyV2RecoveryWitnesses(raw: readonly SignedV2RecoveryWitness[], archive: readonly VerifiedSharedRoster[], groupId: string) {
  if (!Array.isArray(raw) || raw.length > MAX_V2_RECOVERY_WITNESSES) throw new Error('Recovery history exceeds its supported limit');
  const witnesses = raw.map(validateV2RecoveryWitness); const ids = new Set<string>(); const events = new Set<string>(); let version = 0;
  for (const witness of witnesses) {
    const { body } = verifyV2RecoveryHeader({ body: witness.body, signature: witness.signature }, archive, groupId);
    if (ids.has(body.snapshotId) || body.keyVersion <= version) throw new Error('Duplicate or reordered recovery history');
    for (const entry of body.entries) {
      if (events.has(entry.operationId)) throw new Error('An event cannot be quarantined twice'); events.add(entry.operationId);
    }
    for (const value of witness.preservedFacts) {
      const op = value.fact.operation;
      const epoch = archive[op.keyVersion - 1];
      if (!epoch) throw new Error('Missing original held-fact membership');
      verifyAuthenticatedSharedOperation(value.fact, sharedAuthorIdentity(epoch, op.authorUserId, op.authorDeviceId, op.keyVersion), groupId);
      bindV2ServerReceipt(value.receipt, value.fact, archive);
    }
    ids.add(body.snapshotId); version = body.keyVersion;
  }
  return witnesses;
}
