import { canonicalJson, SHARED_SCHEDULER_VERSION } from '../operations.ts';
import type { VersionVector } from '../operations.ts';
import { buildSharedReplica, validateSharedSnapshotBase } from '../replica.ts';
import type { SharedReplica } from '../replica.ts';
import { sharedDocumentDigest, verifyAuthenticatedSharedOperation } from '../crypto.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterArchive } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { openEncryptedSharedSnapshot } from '../snapshots.ts';
import type { EncryptedSharedSnapshot, VerifiedSharedSnapshot } from '../snapshots.ts';
import { signLegacyMigrationWitness, validateLegacyMigrationWitness, verifyLegacyMigrationWitness } from './legacy-migration-witness.ts';
import type { SignedLegacyMigrationWitness } from './legacy-migration-witness.ts';
import type { GroupKind } from './model.ts';

declare const verifiedLegacyMigration: unique symbol;
export interface VerifiedLegacyMigration {
  readonly [verifiedLegacyMigration]: true;
  readonly sourceSnapshotDigest: string;
  readonly frontier: Readonly<VersionVector>;
}
interface Source { groupId: string; rosterDigest: string; roster: VerifiedSharedRoster; archive: readonly VerifiedSharedRoster[];
  snapshot: VerifiedSharedSnapshot; replica: SharedReplica; witness?: SignedLegacyMigrationWitness }
const sources = new WeakMap<VerifiedLegacyMigration, Source>();
export class UnverifiedLegacyMigrationError extends Error { readonly code = 'sharing/v2-migration-unverified'; }
function reject(message: string): never { throw new UnverifiedLegacyMigrationError(message); }
function sourceFor(checkpoint: VerifiedLegacyMigration): Source {
  return sources.get(checkpoint) ?? reject('Reverify the encrypted legacy snapshot before using a migration checkpoint');
}

/** The pin and expected position must come from protected local sync state, never the proposed migration payload. */
export async function verifyLegacyMigrationSource(input: {
  crypto: SharingCryptoGateway; encrypted: EncryptedSharedSnapshot; key: Uint8Array;
  anchor: VerifiedSharedRoster; archive: readonly VerifiedSharedRoster[];
  expectedSnapshotDigest: string; expectedThroughSequence: number; pendingLocalOperationIds: readonly string[];
}): Promise<VerifiedLegacyMigration> {
  // Capture mutable caller input before the first await; retain no key in the verified checkpoint.
  const encrypted = JSON.parse(canonicalJson(input.encrypted)) as EncryptedSharedSnapshot;
  const anchor = JSON.parse(canonicalJson(input.anchor)) as VerifiedSharedRoster;
  const archive = verifySharedRosterArchive(anchor, JSON.parse(canonicalJson(input.archive)));
  const roster = archive.at(-1)!;
  const digest = input.expectedSnapshotDigest; const position = input.expectedThroughSequence;
  if (archive.some(entry => entry.body.schemaVersion !== 1 || entry.body.schedulerVersion !== SHARED_SCHEDULER_VERSION)
    || roster.body.closed || input.pendingLocalOperationIds.length) reject('Finish legacy synchronization before preparing its migration');
  if (!/^[a-f0-9]{64}$/u.test(digest) || sharedDocumentDigest(encrypted.manifest) !== digest
    || !Number.isSafeInteger(position) || position < 0 || encrypted.manifest.body.throughSequence !== position) reject('Legacy snapshot differs from the protected checkpoint');
  const key = new Uint8Array(input.key);
  try {
    const snapshot = await openEncryptedSharedSnapshot(input.crypto, encrypted, key, roster, (user, device, version) => {
      const epoch = archive[version - 1]; if (!epoch) return reject('Unknown legacy author epoch');
      return sharedAuthorIdentity(epoch, user, device, version);
    });
    if (snapshot.base.operations.some(op => op.schemaVersion !== 1)) reject('A legacy checkpoint cannot contain v2 operations');
    const replica = buildSharedReplica(roster.body.groupId, [], snapshot.base);
    if (replica.pendingOperationIds.length) reject('Legacy source has incomplete causal history');
    const checkpoint = Object.freeze({ sourceSnapshotDigest: digest, frontier: Object.freeze({ ...snapshot.base.frontier }) }) as VerifiedLegacyMigration;
    sources.set(checkpoint, { groupId: roster.body.groupId, rosterDigest: sharedRosterDigest(roster), roster, archive, snapshot, replica });
    return checkpoint;
  } finally { key.fill(0); }
}

/** A structural object or deserialized payload is not evidence, even if it supplies matching field names. */
export function assertVerifiedLegacyMigration(checkpoint: VerifiedLegacyMigration, replica: SharedReplica, archive: readonly VerifiedSharedRoster[]): void {
  const source = sourceFor(checkpoint); const lastLegacy = archive.filter(entry => entry.body.schemaVersion === 1).at(-1);
  const transition = lastLegacy && archive[lastLegacy.body.revision];
  if (replica.groupId !== source.groupId || !lastLegacy || sharedRosterDigest(lastLegacy) !== source.rosterDigest
    || transition?.body.schemaVersion !== 2) reject('Legacy source does not bind this protocol transition');
  if (source.witness && canonicalJson(replica.legacyMigrationWitness ?? null) !== canonicalJson(source.witness)) reject('Migration snapshot dropped or replaced its original owner statement');
  const expected = new Map(source.snapshot.base.operationIndex.map(entry => [entry.operationId, entry]));
  const actual = new Map(replica.operationIndex.filter(entry => entry.sequence <= (checkpoint.frontier[entry.deviceId] ?? 0)).map(entry => [entry.operationId, entry]));
  if (expected.size !== actual.size || [...expected].some(([id, receipt]) => canonicalJson(actual.get(id) ?? null) !== canonicalJson(receipt))) reject('Migrated legacy receipts differ from the verified source');
  const retained = new Map(replica.operations.map(op => [op.operationId, op]));
  if (source.snapshot.base.operations.some(op => canonicalJson(retained.get(op.operationId) ?? null) !== canonicalJson(op))) reject('Migration discarded or rewrote retained legacy facts');
}

/** Kept inside encrypted schema2 snapshots so a new member needs no old group decryption key. */
export function bindLegacyMigrationWitness(checkpoint: VerifiedLegacyMigration, target: VerifiedSharedRoster,
  owner: DeviceSecretIdentity, kind: GroupKind) {
  const source = sourceFor(checkpoint);
  const witness = signLegacyMigrationWitness({ base: source.snapshot.base, source: source.roster, target, owner, kind,
    sourceSnapshotDigest: checkpoint.sourceSnapshotDigest, sourceSnapshotId: source.snapshot.snapshotId, sourceThroughSequence: source.snapshot.throughSequence });
  verifyLegacyMigrationWitness(witness, source.snapshot.base, [...source.archive, target]);
  const bound = Object.freeze({ sourceSnapshotDigest: checkpoint.sourceSnapshotDigest, frontier: Object.freeze({ ...checkpoint.frontier }) }) as VerifiedLegacyMigration;
  sources.set(bound, { ...source, witness: validateLegacyMigrationWitness(witness) });
  const snapshot: VerifiedSharedSnapshot = { ...source.snapshot, base: { ...source.snapshot.base, legacyMigrationWitness: witness } };
  return { checkpoint: bound, witness, snapshot, replica: buildSharedReplica(source.groupId, [], snapshot.base) };
}

/** Incoming snapshots must first pass the current-owner manifest/decryption checks. Local restore uses the protected checkpoint. */
export function restoreLegacyMigrationSourceFromSnapshot(value: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[],
  expected?: { sourceSnapshotDigest: string; witnessDigest: string }): VerifiedLegacyMigration {
  if (!archive.length) return reject('Missing protected membership anchor');
  const history = verifySharedRosterArchive(archive[0], JSON.parse(canonicalJson(archive)));
  const snapshot = JSON.parse(JSON.stringify(value)) as VerifiedSharedSnapshot;
  if (!snapshot.base.legacyMigrationWitness) return reject('The encrypted migration snapshot is missing its owner statement');
  const witness = validateLegacyMigrationWitness(snapshot.base.legacyMigrationWitness); const b = witness.body;
  if (expected && (expected.sourceSnapshotDigest !== b.sourceSnapshotDigest || expected.witnessDigest !== sharedDocumentDigest(witness))) reject('The locally pinned migration source or statement changed');
  const base = validateSharedSnapshotBase(b.groupId, { groupId: b.groupId, frontier: { ...b.sourceFrontier }, logicalClock: b.sourceLogicalClock,
    operationIndex: snapshot.base.operationIndex.filter(item => item.sequence <= (b.sourceFrontier[item.deviceId] ?? 0)),
    operations: snapshot.base.operations.filter(op => op.schemaVersion === 1) });
  verifyLegacyMigrationWitness(witness, base, history);
  const facts = snapshot.facts.filter(fact => fact.operation.schemaVersion === 1);
  if (facts.length !== base.operations.length || new Set(facts.map(fact => fact.operation.operationId)).size !== facts.length) reject('Missing or repeated original legacy author proofs');
  const byId = new Map(facts.map(fact => [fact.operation.operationId, fact]));
  for (const op of base.operations) {
    const fact = byId.get(op.operationId); const epoch = history[op.keyVersion - 1];
    if (!fact || !epoch || canonicalJson(fact.operation) !== canonicalJson(op)) reject('Legacy fact differs from its original author proof');
    verifyAuthenticatedSharedOperation(fact, sharedAuthorIdentity(epoch, op.authorUserId, op.authorDeviceId, op.keyVersion), b.groupId);
  }
  const roster = history[b.sourceKeyVersion - 1];
  const checkpoint = Object.freeze({ sourceSnapshotDigest: b.sourceSnapshotDigest, frontier: Object.freeze({ ...b.sourceFrontier }) }) as VerifiedLegacyMigration;
  sources.set(checkpoint, { groupId: b.groupId, roster, rosterDigest: sharedRosterDigest(roster), archive: history.slice(0, b.sourceKeyVersion),
    snapshot: { base, facts, snapshotId: b.sourceSnapshotId, throughSequence: b.sourceThroughSequence }, replica: buildSharedReplica(b.groupId, [], base), witness });
  assertVerifiedLegacyMigration(checkpoint, buildSharedReplica(b.groupId, [], snapshot.base), history);
  return checkpoint;
}

export function verifiedLegacyMigrationKind(checkpoint: VerifiedLegacyMigration): GroupKind | undefined { return sourceFor(checkpoint).witness?.body.groupKind; }
export function verifiedLegacyMigrationPin(checkpoint: VerifiedLegacyMigration) {
  const source = sourceFor(checkpoint);
  if (!source.witness) return reject('Prepare the owner-approved migration statement first');
  return { sourceSnapshotDigest: checkpoint.sourceSnapshotDigest, witnessDigest: sharedDocumentDigest(source.witness) };
}
export function readVerifiedLegacyMigrationSnapshot(checkpoint: VerifiedLegacyMigration): VerifiedSharedSnapshot {
  const source = sourceFor(checkpoint);
  return JSON.parse(JSON.stringify({ ...source.snapshot, base: { ...source.snapshot.base,
    ...(source.witness ? { legacyMigrationWitness: source.witness } : {}) } })) as VerifiedSharedSnapshot;
}

/** Detached shared-only values for a local preview; no database mutation, operation creation or cloud activation. */
export function readVerifiedLegacyMigrationSource(checkpoint: VerifiedLegacyMigration) {
  const source = sourceFor(checkpoint);
  // A validated snapshot may contain more than the per-operation canonical array limit.
  return JSON.parse(JSON.stringify({ roster: source.roster, replica: { ...source.replica,
    ...(source.witness ? { legacyMigrationWitness: source.witness } : {}) }, snapshotId: source.snapshot.snapshotId,
    throughSequence: source.snapshot.throughSequence, sourceSnapshotDigest: checkpoint.sourceSnapshotDigest })) as {
    roster: VerifiedSharedRoster; replica: SharedReplica; snapshotId: string; throughSequence: number; sourceSnapshotDigest: string;
  };
}
