import { assertJsonRecord, assertSharedIdentifier, canonicalJson, compareOperationIds } from '../operations.ts';
import type { VersionVector } from '../operations.ts';
import { sharedDocumentDigest, signSharedDocument, validateDevicePublicIdentity, verifySharedDocument } from '../crypto.ts';
import type { DevicePublicIdentity, DeviceSecretIdentity } from '../crypto.ts';
import { sharedRosterDigest, verifySharedRosterTransition } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { SharedSnapshotBase } from '../replica.ts';
import type { GroupKind } from './model.ts';

export interface LegacyMigrationWitnessBody {
  schemaVersion: 1; groupId: string; groupKind: GroupKind;
  sourceKeyVersion: number; sourceRosterDigest: string; targetKeyVersion: number; targetRosterDigest: string;
  sourceSnapshotDigest: string; sourceSnapshotId: string; sourceThroughSequence: number;
  sourceFrontier: VersionVector; sourceLogicalClock: number; receiptCount: number; factCount: number;
  receiptPageDigests: string[]; factPageDigests: string[];
}
export interface SignedLegacyMigrationWitness { body: LegacyMigrationWitnessBody; signer: DevicePublicIdentity; signature: string }
const domain = 'liflow-legacy-migration-witness-v1';
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
function exact(value: unknown, keys: readonly string[]) {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) throw new Error('Unknown migration witness field');
}
function pages(values: readonly unknown[]) {
  const digests: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) digests.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return digests;
}
function content(base: SharedSnapshotBase) {
  return { receiptCount: base.operationIndex.length, factCount: base.operations.length,
    receiptPageDigests: pages([...base.operationIndex].sort((a, b) => compareOperationIds(a.operationId, b.operationId))),
    factPageDigests: pages([...base.operations].sort((a, b) => compareOperationIds(a.operationId, b.operationId)).map(op => sharedDocumentDigest(op))) };
}
export function validateLegacyMigrationWitness(input: SignedLegacyMigrationWitness): SignedLegacyMigrationWitness {
  exact(input, ['body', 'signer', 'signature']);
  exact(input.signer, ['deviceId', 'signingPublicKey', 'agreementPublicKey']);
  exact(input.body, ['schemaVersion', 'groupId', 'groupKind', 'sourceKeyVersion', 'sourceRosterDigest', 'targetKeyVersion', 'targetRosterDigest',
    'sourceSnapshotDigest', 'sourceSnapshotId', 'sourceThroughSequence', 'sourceFrontier', 'sourceLogicalClock', 'receiptCount', 'factCount', 'receiptPageDigests', 'factPageDigests']);
  const b = input.body;
  assertSharedIdentifier(b.groupId); assertSharedIdentifier(b.sourceSnapshotId);
  if (b.schemaVersion !== 1 || !['family', 'roommates'].includes(b.groupKind)
    || [b.sourceRosterDigest, b.targetRosterDigest, b.sourceSnapshotDigest].some(value => !hash(value))) throw new Error('Invalid migration witness binding');
  for (const n of [b.sourceKeyVersion, b.targetKeyVersion]) if (!Number.isSafeInteger(n) || n < 1) throw new Error('Invalid migration witness epoch');
  if (b.targetKeyVersion !== b.sourceKeyVersion + 1) throw new Error('Migration must use its exact next membership epoch');
  for (const n of [b.sourceThroughSequence, b.sourceLogicalClock, b.receiptCount, b.factCount]) if (!Number.isSafeInteger(n) || n < 0) throw new Error('Invalid migration witness count');
  if (b.factCount > b.receiptCount || b.receiptCount > 512_000) throw new Error('Migration witness exceeds snapshot capacity');
  assertJsonRecord(b.sourceFrontier);
  if (Object.keys(b.sourceFrontier).length > 256) throw new Error('Invalid migration witness frontier');
  let total = 0;
  for (const [device, n] of Object.entries(b.sourceFrontier)) { assertSharedIdentifier(device); if (!Number.isSafeInteger(n) || n < 0 || n > b.sourceLogicalClock) throw new Error('Invalid migration witness frontier'); total += n; }
  if (total !== b.receiptCount) throw new Error('Incomplete migration witness frontier');
  for (const [values, count] of [[b.receiptPageDigests, b.receiptCount], [b.factPageDigests, b.factCount]] as const) {
    if (!Array.isArray(values) || values.length !== Math.ceil(count / 1000) || values.some(value => !hash(value))) throw new Error('Invalid migration witness pages');
  }
  const signer = validateDevicePublicIdentity(input.signer); verifySharedDocument({ domain, body: b }, input.signature, signer);
  return JSON.parse(canonicalJson(input)) as SignedLegacyMigrationWitness;
}

/** Only the source owner signs this explicit transition, using the existing document-signature primitive. */
export function signLegacyMigrationWitness(input: {
  base: SharedSnapshotBase; source: VerifiedSharedRoster; target: VerifiedSharedRoster; owner: DeviceSecretIdentity;
  kind: GroupKind; sourceSnapshotDigest: string; sourceSnapshotId: string; sourceThroughSequence: number;
}): SignedLegacyMigrationWitness {
  const { source, target, base, owner } = input; verifySharedRosterTransition(source, target);
  if (source.body.schemaVersion !== 1 || target.body.schemaVersion !== 2 || source.body.groupId !== base.groupId
    || owner.deviceId !== source.body.ownerDeviceId || base.operations.some(op => op.schemaVersion !== 1)) throw new Error('Invalid legacy migration signer or source');
  const body: LegacyMigrationWitnessBody = { schemaVersion: 1, groupId: base.groupId, groupKind: input.kind,
    sourceKeyVersion: source.body.keyVersion, sourceRosterDigest: sharedRosterDigest(source), targetKeyVersion: target.body.keyVersion, targetRosterDigest: sharedRosterDigest(target),
    sourceSnapshotDigest: input.sourceSnapshotDigest, sourceSnapshotId: input.sourceSnapshotId, sourceThroughSequence: input.sourceThroughSequence,
    sourceFrontier: { ...base.frontier }, sourceLogicalClock: base.logicalClock, ...content(base) };
  return validateLegacyMigrationWitness({ body, signer: validateDevicePublicIdentity(owner), signature: signSharedDocument({ domain, body }, owner) });
}

/** This statement is itself inside the authenticated current-owner snapshot, never an event-payload trust pin. */
export function verifyLegacyMigrationWitness(input: SignedLegacyMigrationWitness, sourceBase: SharedSnapshotBase,
  archive: readonly VerifiedSharedRoster[]): SignedLegacyMigrationWitness {
  const witness = validateLegacyMigrationWitness(input); const b = witness.body;
  const source = archive[b.sourceKeyVersion - 1]; const target = archive[b.targetKeyVersion - 1];
  if (!source || !target || source.body.schemaVersion !== 1 || target.body.schemaVersion !== 2
    || archive.slice(0, b.sourceKeyVersion).some(entry => entry.body.schemaVersion !== 1)
    || sharedRosterDigest(source) !== b.sourceRosterDigest || sharedRosterDigest(target) !== b.targetRosterDigest
    || source.body.groupId !== b.groupId || sourceBase.groupId !== b.groupId) throw new Error('Migration witness belongs to another transition');
  verifySharedRosterTransition(source, target);
  const owner = source.body.members.find(member => member.userId === source.body.ownerUserId)?.devices.find(device => device.identity.deviceId === source.body.ownerDeviceId)?.identity;
  if (canonicalJson(owner ?? null) !== canonicalJson(witness.signer) || canonicalJson(sourceBase.frontier) !== canonicalJson(b.sourceFrontier)
    || sourceBase.logicalClock !== b.sourceLogicalClock || sourceBase.operations.some(op => op.schemaVersion !== 1)
    || canonicalJson(content(sourceBase)) !== canonicalJson({ receiptCount: b.receiptCount, factCount: b.factCount, receiptPageDigests: b.receiptPageDigests, factPageDigests: b.factPageDigests })) throw new Error('Migration witness does not retain the exact owner-approved source');
  return witness;
}
