import { canonicalJson, SHARED_SCHEDULER_VERSION } from '../operations.ts';
import type { VersionVector } from '../operations.ts';
import { buildSharedReplica } from '../replica.ts';
import type { SharedReplica } from '../replica.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import type { SharingCryptoGateway } from '../crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterArchive } from '../roster.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import { openEncryptedSharedSnapshot } from '../snapshots.ts';
import type { EncryptedSharedSnapshot, VerifiedSharedSnapshot } from '../snapshots.ts';

declare const verifiedLegacyMigration: unique symbol;
export interface VerifiedLegacyMigration {
  readonly [verifiedLegacyMigration]: true;
  readonly sourceSnapshotDigest: string;
  readonly frontier: Readonly<VersionVector>;
}
interface Source { groupId: string; rosterDigest: string; roster: VerifiedSharedRoster; snapshot: VerifiedSharedSnapshot; replica: SharedReplica }
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
    sources.set(checkpoint, { groupId: roster.body.groupId, rosterDigest: sharedRosterDigest(roster), roster, snapshot, replica });
    return checkpoint;
  } finally { key.fill(0); }
}

/** A structural object or deserialized payload is not evidence, even if it supplies matching field names. */
export function assertVerifiedLegacyMigration(checkpoint: VerifiedLegacyMigration, replica: SharedReplica, archive: readonly VerifiedSharedRoster[]): void {
  const source = sourceFor(checkpoint); const lastLegacy = archive.filter(entry => entry.body.schemaVersion === 1).at(-1);
  const transition = lastLegacy && archive[lastLegacy.body.revision];
  if (replica.groupId !== source.groupId || !lastLegacy || sharedRosterDigest(lastLegacy) !== source.rosterDigest
    || transition?.body.schemaVersion !== 2) reject('Legacy source does not bind this protocol transition');
  const expected = new Map(source.snapshot.base.operationIndex.map(entry => [entry.operationId, entry]));
  const actual = new Map(replica.operationIndex.filter(entry => entry.sequence <= (checkpoint.frontier[entry.deviceId] ?? 0)).map(entry => [entry.operationId, entry]));
  if (expected.size !== actual.size || [...expected].some(([id, receipt]) => canonicalJson(actual.get(id) ?? null) !== canonicalJson(receipt))) reject('Migrated legacy receipts differ from the verified source');
  const retained = new Map(replica.operations.map(op => [op.operationId, op]));
  if (source.snapshot.base.operations.some(op => canonicalJson(retained.get(op.operationId) ?? null) !== canonicalJson(op))) reject('Migration discarded or rewrote retained legacy facts');
}

/** Detached shared-only values for a local preview; no database mutation, operation creation or cloud activation. */
export function readVerifiedLegacyMigrationSource(checkpoint: VerifiedLegacyMigration) {
  const source = sourceFor(checkpoint);
  // A validated snapshot may contain more than the per-operation canonical array limit.
  return JSON.parse(JSON.stringify({ roster: source.roster, replica: source.replica, snapshotId: source.snapshot.snapshotId,
    throughSequence: source.snapshot.throughSequence, sourceSnapshotDigest: checkpoint.sourceSnapshotDigest })) as {
    roster: VerifiedSharedRoster; replica: SharedReplica; snapshotId: string; throughSequence: number; sourceSnapshotDigest: string;
  };
}
