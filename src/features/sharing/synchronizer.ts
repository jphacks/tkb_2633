import type { SQLiteDatabase } from 'expo-sqlite';
import type { createSharingCloud } from '../../platform/sharing/firestore-cloud.ts';
import type { SharingWorkspaceRecord } from '../../platform/storage/sharing-registry.ts';
import type { SharedReplica } from './replica.ts';
import { canonicalJson, SHARED_SCHEDULER_VERSION } from './operations.ts';
import { decryptAuthenticatedSharedOperation, encryptSharedOperation, sharedDocumentDigest, unwrapGroupKey } from './crypto.ts';
import type { AuthenticatedSharedOperation, DeviceSecretIdentity, SharingCryptoGateway } from './crypto.ts';
import { assertSharedCloudAccess, SharingAccessError, SharingKeyVersionError, SharingSchedulerVersionError, SharingSnapshotRequiredError } from './cloud-contract.ts';
import type { SharedCloudGroup } from './cloud-contract.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifyPinnedSharedRoster, verifySharedRosterArchive, verifySharedRosterTransition } from './roster.ts';
import type { SignedSharedRoster, VerifiedSharedRoster } from './roster.ts';
import { openEncryptedSharedSnapshot } from './snapshots.ts';
import { acknowledgeSharingUpload, applyReceivedSharedFacts, applySharingSnapshot, deferSharingUpload, listSharingOutbox,
  loadSharedReplica, readSharingCheckpoint, replaceSharingEnvelopeAfterRotation, saveSharingEnvelope } from '../../platform/storage/sharing-ledger.ts';

export type SharingCloud = ReturnType<typeof createSharingCloud>;
export interface SharingSyncResult { sent: number; received: number; pending: number; waitingForApproval: boolean; complete: boolean }
export interface SharedSyncDependencies {
  database: SQLiteDatabase; groupId: string; userId: string; identity: DeviceSecretIdentity; crypto: SharingCryptoGateway; cloud: SharingCloud;
  readRecord: () => Promise<SharingWorkspaceRecord>; saveArchive: (archive: VerifiedSharedRoster[]) => Promise<void>;
  readKey: (version: number) => Promise<Uint8Array | null>; saveKey: (version: number, bytes: Uint8Array) => Promise<void>;
  project: (transaction: SQLiteDatabase, replica: SharedReplica) => Promise<void>;
  serialized: <T>(operation: () => Promise<T>) => Promise<T>; changed: () => void; now?: () => number;
}
const verifiedArchives = new WeakMap<SharedSyncDependencies, { pin: string; archive: VerifiedSharedRoster[] }>();

/** A durable trust pin, never a server-supplied public key, anchors every epoch. */
export async function verifyCloudMembership(deps: SharedSyncDependencies, current: SignedSharedRoster): Promise<VerifiedSharedRoster[]> {
  const record = await deps.readRecord();
  if (record.userId !== deps.userId || record.groupId !== deps.groupId || ['left', 'removed'].includes(record.status)) throw new SharingAccessError('この共有グループは利用できません。');
  const last = record.rosterArchive.at(-1);
  if (current.body.revision > 4096 || (last && current.body.revision < last.body.revision)) throw new Error('Shared membership rollback or history limit');
  const pin = 'body' in record.anchor ? { groupId: record.groupId, digest: sharedRosterDigest(record.anchor),
    ownerUserId: record.anchor.body.ownerUserId, ownerIdentity: record.anchor.signer } : record.anchor;
  const pinRevision = 'body' in record.anchor ? record.anchor.body.revision : record.anchor.revision;
  const cached = verifiedArchives.get(deps);
  if (cached?.pin === pin.digest && cached.archive.length <= current.body.revision) {
    const archive = [...cached.archive];
    for (let revision = archive.length + 1; revision <= current.body.revision; revision++) archive.push(verifySharedRosterTransition(archive.at(-1)!,
      revision === current.body.revision ? current : record.rosterArchive[revision - 1] ?? await deps.cloud.readRoster(deps.groupId, revision)));
    const latest = archive.at(-1)!;
    if (sharedRosterDigest(latest) !== sharedRosterDigest(current)) throw new Error('Shared membership changed at an existing revision');
    if (record.join && sharedRosterDigest(archive[record.join.invitation.body.pin.revision - 1]) !== record.join.invitation.body.pin.digest) throw new Error('Invitation does not reach the previously trusted membership chain');
    if (latest.body.schedulerVersion !== SHARED_SCHEDULER_VERSION) throw new SharingSchedulerVersionError();
    await deps.saveArchive(archive); verifiedArchives.set(deps, { pin: pin.digest, archive }); return archive;
  }
  const inputs = [...record.rosterArchive];
  for (let revision = inputs.length + 1; revision <= current.body.revision; revision++) inputs.push(
    revision === current.body.revision ? current : await deps.cloud.readRoster(deps.groupId, revision));
  if (!inputs[pinRevision - 1]) throw new Error('Missing trusted membership pin');
  const archive = verifySharedRosterArchive(verifyPinnedSharedRoster(inputs[pinRevision - 1], pin), inputs);
  if (record.join && sharedRosterDigest(archive[record.join.invitation.body.pin.revision - 1]) !== record.join.invitation.body.pin.digest) throw new Error('Invitation does not reach the previously trusted membership chain');
  const latest = archive.at(-1)!;
  if (sharedRosterDigest(latest) !== sharedRosterDigest(current)) throw new Error('Shared membership changed at an existing revision');
  if (latest.body.schedulerVersion !== SHARED_SCHEDULER_VERSION) throw new SharingSchedulerVersionError();
  await deps.saveArchive(archive); verifiedArchives.set(deps, { pin: pin.digest, archive }); return archive;
}

/** One coordinator per workspace. Process exits leave events, never a persisted "syncing" lock. */
export function createSharedSynchronizer(deps: SharedSyncDependencies) {
  const now = deps.now ?? Date.now; let running: Promise<SharingSyncResult> | null = null; let requested = false; let forceRequested = false;
  async function keyFor(roster: VerifiedSharedRoster): Promise<Uint8Array> {
    const version = roster.body.keyVersion; const saved = await deps.readKey(version); if (saved) return saved.slice();
    const wrapped = await deps.cloud.readGroupKey(deps.groupId, version, deps.identity.deviceId);
    const owner = roster.body.members.flatMap((member) => member.devices).find((device) => device.identity.deviceId === roster.body.ownerDeviceId)?.identity;
    const sender = wrapped.senderDeviceId === roster.signer.deviceId ? roster.signer : owner;
    if (!sender || wrapped.senderDeviceId !== sender.deviceId) throw new Error('共有鍵の配布元を確認できません。');
    const key = await unwrapGroupKey(deps.crypto, wrapped, deps.identity, deps.userId, sender, deps.groupId, version);
    await deps.saveKey(version, key); return key;
  }
  async function perform(options: { force?: boolean; budgetMs?: number }): Promise<SharingSyncResult> {
    const deadline = now() + Math.max(1000, Math.min(options.budgetMs ?? 20_000, 120_000));
    let sent = 0; let received = 0; let metadata;
    const waiting = async (): Promise<SharingSyncResult> => ({ sent, received,
      pending: (await readSharingCheckpoint(deps.database, deps.groupId)).pendingCount, waitingForApproval: true, complete: false });
    try { metadata = await deps.cloud.readGroup(deps.groupId); }
    catch (error) {
      if ((await deps.readRecord()).status === 'joining' && error && typeof error === 'object' && 'code' in error
        && ['permission-denied', 'sharing/access-denied'].includes(String(error.code))) return waiting();
      throw error;
    }
    let archive = await verifyCloudMembership(deps, metadata.roster); let roster = archive.at(-1)!;
    if (metadata.group.deviceOwners[deps.identity.deviceId] !== deps.userId && (await deps.readRecord()).status === 'joining') return waiting();
    assertSharedCloudAccess(metadata.group, deps.userId, deps.identity.deviceId);
    const historicalAuthor = (uid: string, device: string, version: number) => {
      const epoch = archive.find((item) => item.body.keyVersion === version);
      if (!epoch) throw new Error('Missing original author membership'); return sharedAuthorIdentity(epoch, uid, device, version);
    };
    const keys = new Map<number, Uint8Array>();
    const getKey = async (epoch: VerifiedSharedRoster) => {
      let bytes = keys.get(epoch.body.keyVersion);
      if (!bytes) { bytes = await keyFor(epoch); keys.set(epoch.body.keyVersion, bytes); } return bytes;
    };
    const adoptSnapshot = async (group: SharedCloudGroup) => {
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      if (!group.snapshotId || group.snapshotId === checkpoint.snapshotId) return;
      const encrypted = await deps.cloud.readSnapshot(deps.groupId, group.snapshotId);
      const epoch = archive.find((item) => sharedRosterDigest(item) === encrypted.manifest.body.rosterDigest);
      if (!epoch || encrypted.manifest.body.throughSequence !== group.snapshotThroughSequence) throw new Error('Snapshot does not match shared metadata');
      const snapshot = await openEncryptedSharedSnapshot(deps.crypto, encrypted, await getKey(epoch), epoch, historicalAuthor);
      await deps.serialized(() => applySharingSnapshot(deps.database, deps.groupId, snapshot, deps.project, checkpoint.cursor, now())); deps.changed();
    };
    const refreshMetadata = async () => {
      metadata = await deps.cloud.readGroup(deps.groupId); archive = await verifyCloudMembership(deps, metadata.roster); roster = archive.at(-1)!;
      assertSharedCloudAccess(metadata.group, deps.userId, deps.identity.deviceId); await getKey(roster); await adoptSnapshot(metadata.group);
    };
    try {
      await getKey(roster); await adoptSnapshot(metadata.group);
      const pull = async () => {
        let races = 0;
        do {
          const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId); let page;
          try { page = await deps.cloud.pull(deps.groupId, checkpoint.sequence); }
          catch (error) { if (!(error instanceof SharingSnapshotRequiredError) || ++races > 3) throw error; await refreshMetadata(); continue; }
          if (sharedRosterDigest(page.roster) !== sharedRosterDigest(roster)) { await refreshMetadata(); continue; }
          metadata = page;
          if (page.group.snapshotId && page.group.snapshotId !== checkpoint.snapshotId) { await adoptSnapshot(page.group); continue; }
          const facts: AuthenticatedSharedOperation[] = [];
          for (const event of page.events) {
            // Removed authors' history comes from a signed snapshot. New transport events use the current epoch.
            if (event.envelope.keyVersion !== roster.body.keyVersion) throw new SharingKeyVersionError('共有履歴を最新の鍵で再取得する必要があります。');
            const author = sharedAuthorIdentity(roster, event.envelope.authorUserId, event.envelope.authorDeviceId, event.envelope.keyVersion);
            const fact = await decryptAuthenticatedSharedOperation(deps.crypto, event.envelope, await getKey(roster), author, deps.groupId, roster.body.keyVersion);
            sharedAuthorIdentity(roster, fact.operation.authorUserId, fact.operation.authorDeviceId, fact.operation.keyVersion); facts.push(fact);
          }
          if (facts.length) {
            await deps.serialized(() => applyReceivedSharedFacts(deps.database, deps.groupId, facts, String(page.throughSequence), deps.project, checkpoint.cursor, now()));
            received += facts.length; deps.changed();
          }
          if (page.throughSequence >= page.group.headSequence) return true;
        } while (now() < deadline);
        return false;
      };
      let complete = await pull();
      if (metadata.group.rotationRequired) throw new SharingKeyVersionError('退出したメンバーを除いて共有鍵を更新する必要があります。');
      while (now() < deadline) {
        const items = await listSharingOutbox(deps.database, deps.groupId, options.force ? Number.MAX_SAFE_INTEGER : now()); if (!items.length) break;
        for (const item of items) {
          if (now() >= deadline) break;
          const op = item.operation;
          if (op.authorUserId !== deps.userId || op.authorDeviceId !== deps.identity.deviceId) throw new Error('共有の未送信操作が別の端末に属しています。');
          sharedAuthorIdentity(roster, op.authorUserId, op.authorDeviceId, op.keyVersion);
          let encoded = item.encryptedEnvelope;
          if (!encoded) { encoded = canonicalJson(await encryptSharedOperation(deps.crypto, op, await getKey(roster), deps.identity, roster.body.keyVersion)); await saveSharingEnvelope(deps.database, op.operationId, encoded); }
          let accepted;
          try {
            try { accepted = await deps.cloud.upload(JSON.parse(encoded)); }
            catch (error) {
              if (!(error instanceof SharingKeyVersionError)) throw error;
              // upload() checked absence transactionally before reporting the changed server epoch.
              await refreshMetadata(); if (metadata.group.rotationRequired) throw error;
              sharedAuthorIdentity(roster, op.authorUserId, op.authorDeviceId, op.keyVersion);
              const replacement = canonicalJson(await encryptSharedOperation(deps.crypto, op, await getKey(roster), deps.identity, roster.body.keyVersion));
              await replaceSharingEnvelopeAfterRotation(deps.database, deps.groupId, op.operationId, encoded, replacement, roster.body.keyVersion);
              encoded = replacement; accepted = await deps.cloud.upload(JSON.parse(encoded));
            }
          } catch (error) {
            const random = await deps.crypto.randomBytes(4);
            await deferSharingUpload(deps.database, op.operationId, now(), new DataView(random.buffer, random.byteOffset, random.byteLength).getUint32(0) / 0x100000000); throw error;
          }
          const epoch = archive.find((item) => item.body.keyVersion === accepted.envelope.keyVersion); if (!epoch) throw new Error('Accepted event uses an unknown key epoch');
          const fact = await decryptAuthenticatedSharedOperation(deps.crypto, accepted.envelope, await getKey(epoch), deps.identity, deps.groupId, epoch.body.keyVersion);
          if (sharedDocumentDigest(fact.operation) !== sharedDocumentDigest(op)) throw new Error('Server acknowledged a different shared operation');
          await acknowledgeSharingUpload(deps.database, op.operationId, { groupId: deps.groupId, envelope: encoded }); sent++;
        }
      }
      if (now() < deadline) complete = await pull();
      const checkpoint = await readSharingCheckpoint(deps.database, deps.groupId);
      if (complete && !(await loadSharedReplica(deps.database, deps.groupId)).pendingOperationIds.length) await deps.cloud.acknowledge(deps.groupId, deps.identity.deviceId, checkpoint.sequence);
      return { sent, received, pending: checkpoint.pendingCount, waitingForApproval: false, complete };
    } finally { for (const bytes of keys.values()) bytes.fill(0); }
  }
  return { sync(options: { force?: boolean; budgetMs?: number } = {}): Promise<SharingSyncResult> {
    if (running) { requested = true; forceRequested ||= Boolean(options.force); return running; }
    const pending = (async () => {
      let result = await perform(options);
      if (requested) { const force = forceRequested; requested = false; forceRequested = false;
        const next = await perform({ ...options, force: options.force || force }); result = { ...next, sent: result.sent + next.sent, received: result.received + next.received }; }
      return result;
    })(); running = pending;
    void pending.finally(() => { if (running === pending) running = null; requested = false; forceRequested = false; }).catch(() => undefined); return pending;
  } };
}
