import type { SharedSyncDependencies } from '../synchronizer.ts';
import { createSharedSynchronizer } from '../synchronizer.ts';
import type { AuthenticatedSharedOperation } from '../crypto.ts';
import type { SharedCloudEvent } from '../cloud-contract.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { VerifiedSharedSnapshot } from '../snapshots.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { withIsolatedSqliteTransaction } from '../../../platform/storage/isolated-transaction.ts';
import { bindV2ServerReceipt } from './server-receipts.ts';
import type { V2ServerReceipt } from './server-receipts.ts';
import { V2AwaitingReceiptError } from './receiver-authority.ts';
import { V2_SCHEDULER_VERSION } from './payload-schema.ts';

export class V2ReceiptRecoveryPendingError extends Error { readonly code = 'sharing/receipt-recovery-pending'; }

/** Reuse the existing encrypted coordinator; only protocol and receipt-aware projection are specialized. */
export function createV2Synchronizer(dependencies: Omit<SharedSyncDependencies, 'v2' | 'project'> & {
  repository: ReturnType<typeof createV2EventRepository>; assertCurrentAccount: () => void;
}) {
  const { repository, assertCurrentAccount, ...deps } = dependencies;
  if (repository.scope.groupId !== deps.groupId || repository.scope.userId !== deps.userId
    || repository.scope.deviceId !== deps.identity.deviceId) throw new Error('V2 synchronization must use the same account, device and repository');
  const now = deps.now ?? Date.now;
  async function eventEvidence(facts: readonly AuthenticatedSharedOperation[], events: readonly SharedCloudEvent[], archive: readonly VerifiedSharedRoster[]) {
    assertCurrentAccount();
    const originals = new Map(facts.map((fact) => [fact.operation.operationId, fact])); const receipts: V2ServerReceipt[] = [];
    if (originals.size !== events.length || events.length !== facts.length) throw new Error('Receipt evidence has duplicate or missing events');
    for (const event of events) {
      const fact = originals.get(event.operationId); const receipt = event.serverReceipt;
      if (!fact || !receipt || receipt.uploadSequence !== event.uploadSequence || receipt.receivedKeyVersion !== event.envelope.keyVersion
        || receipt.authorProofDigest !== event.authorProofDigest) throw new V2AwaitingReceiptError('Missing independently committed receipt for a received event');
      bindV2ServerReceipt(receipt, fact, archive); receipts.push(receipt);
    }
    return repository.evidenceForServerReceipts(receipts);
  }
  async function snapshotEvidence(snapshot: VerifiedSharedSnapshot, archive: readonly VerifiedSharedRoster[], deadline: number) {
    assertCurrentAccount();
    const facts = new Map(snapshot.facts.filter((fact) => fact.operation.schemaVersion === 2).map((fact) => [fact.operation.operationId, fact]));
    const known = await deps.serialized(() => withIsolatedSqliteTransaction(deps.database, async (transaction) => {
      assertCurrentAccount(); return repository.readReceiptCache(transaction);
    }));
    for (const [id, fact] of facts) { const receipt = known.get(id); if (receipt) bindV2ServerReceipt(receipt, fact, archive); }
    const missing = [...facts.keys()].filter((id) => !known.has(id));
    for (let offset = 0; offset < missing.length; offset += 1000) {
      if (now() >= deadline) throw new V2ReceiptRecoveryPendingError('受付記録の復旧を保存しました。次の同期で続けます。');
      const ids = missing.slice(offset, offset + 1000); const requested = new Set(ids);
      const page = await deps.cloud.readReceipts(deps.groupId, ids, { deadlineAtMs: deadline }); assertCurrentAccount();
      if (new Set(page.map((receipt) => receipt.operationId)).size !== page.length) throw new Error('Duplicate recovered receipt');
      for (const receipt of page) {
        const fact = facts.get(receipt.operationId);
        if (!fact || !requested.has(receipt.operationId)) throw new Error('Recovered receipt belongs to an unrequested fact');
        bindV2ServerReceipt(receipt, fact, archive);
      }
      // Persist verified progress separately; the snapshot cursor/outbox stay unchanged until all evidence is available.
      await deps.serialized(() => withIsolatedSqliteTransaction(deps.database, async (transaction) => {
        assertCurrentAccount(); await repository.evidenceForServerReceipts(page).record(transaction); assertCurrentAccount();
      }));
      if (page.length !== ids.length) {
        if (now() >= deadline) throw new V2ReceiptRecoveryPendingError('受付記録の復旧を保存しました。次の同期で続けます。');
        throw new V2AwaitingReceiptError('Snapshotの操作に対応する受付記録を確認できません。');
      }
    }
    return repository.evidenceForServerReceipts([]);
  }
  return createSharedSynchronizer({ ...deps,
    project: async (transaction, replica) => { assertCurrentAccount(); await repository.project(transaction, replica); assertCurrentAccount(); },
    v2: { schedulerVersion: V2_SCHEDULER_VERSION, eventEvidence, snapshotEvidence } });
}
