import type { SQLiteDatabase } from 'expo-sqlite';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { SharedOperation } from '../../features/sharing/operations.ts';
import type { SharedReplica } from '../../features/sharing/replica.ts';
import { sharedDocumentDigest, signSharedOperation, verifyAuthenticatedSharedOperation } from '../../features/sharing/crypto.ts';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { sharedAuthorIdentity, sharedRosterDigest, verifySharedRosterArchive } from '../../features/sharing/roster.ts';
import type { VerifiedSharedRoster } from '../../features/sharing/roster.ts';
import { assessV2BusinessHistory } from '../../features/sharing/v2/receiver-authority.ts';
import type { VerifiedLegacyMigration } from '../../features/sharing/v2/receiver-authority.ts';
import { rosterAtOperation } from '../../features/sharing/v2/authority-context.ts';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema.ts';
import { SharingAccessError, SharingSchedulerVersionError } from '../../features/sharing/cloud-contract.ts';
import { assertSharedProjectionCanInitialize, initializeSharedProjection } from './sharing-projection.ts';
import { createLocalSharedOperations, initializeSharingLedger, readSharedFactsInsideTransaction } from './sharing-ledger.ts';
import type { SharedOperationDraft, SharedLedgerEvidence } from './sharing-ledger.ts';
import { withIsolatedSqliteTransaction } from './isolated-transaction.ts';
import { initializeV2ReceiptTable, persistV2ServerReceiptsInside, readV2ServerReceiptsInside } from './sharing-v2-receipts.ts';
import { bindV2ServerReceipt, v2AuthorProofDigest } from '../../features/sharing/v2/server-receipts.ts';
import type { V2ServerReceipt } from '../../features/sharing/v2/server-receipts.ts';

interface V2StoreScope { userId: string; groupId: string; householdId: string }
function digestPages(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (let offset = 0; offset < values.length; offset += 1000) result.push(sharedDocumentDigest(values.slice(offset, offset + 1000)));
  return result;
}

/** A fresh, explicitly selected DB only. Existing private and v1 workspaces are never converted in place. */
export async function initializeV2EventStore(database: SQLiteDatabase, scope: V2StoreScope): Promise<void> {
  const tables = new Set((await database.getAllAsync<{ name: string }>("SELECT name FROM sqlite_master WHERE type='table'")).map((row) => row.name));
  if (tables.has('sharing_workspace_metadata') && !tables.has('sharing_v2_binding')) throw new Error('Prepare a separate v2 database before migrating a v1 workspace');
  if (!tables.has('sharing_v2_binding') && tables.has('sharing_operations') && await database.getFirstAsync('SELECT 1 FROM sharing_operations LIMIT 1')) throw new Error('An existing unbound ledger requires a verified migration');
  await assertSharedProjectionCanInitialize(database);
  await withIsolatedSqliteTransaction(database, async (transaction) => {
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_binding (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), user_id TEXT NOT NULL, group_id TEXT NOT NULL,
      household_id TEXT NOT NULL, schema_version INTEGER NOT NULL CHECK(schema_version=2));`);
    await transaction.runAsync('INSERT OR IGNORE INTO sharing_v2_binding VALUES (1, ?, ?, ?, 2)', scope.userId, scope.groupId, scope.householdId);
    await assertV2Binding(transaction, scope);
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_projection (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1), fact_hash TEXT NOT NULL, accepted_ids_json TEXT NOT NULL,
      rejected_json TEXT NOT NULL, pending_ids_json TEXT NOT NULL, provisional_ids_json TEXT NOT NULL DEFAULT '[]');`);
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'provisional_ids_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN provisional_ids_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'request_states_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN request_states_json TEXT NOT NULL DEFAULT '[]'");
    }
    if (!(await transaction.getAllAsync<{ name: string }>('PRAGMA table_info(sharing_v2_projection)')).some((column) => column.name === 'formal_rules_json')) {
      await transaction.execAsync("ALTER TABLE sharing_v2_projection ADD COLUMN formal_rules_json TEXT NOT NULL DEFAULT '[]'");
    }
    await initializeV2ReceiptTable(transaction);
  });
  await initializeSharedProjection(database, scope); await initializeSharingLedger(database);
}
async function assertV2Binding(database: SQLiteDatabase, scope: V2StoreScope): Promise<void> {
  const stored = await database.getFirstAsync<{ user_id: string; group_id: string; household_id: string; schema_version: number }>('SELECT * FROM sharing_v2_binding WHERE singleton=1');
  if (stored?.user_id !== scope.userId || stored.group_id !== scope.groupId || stored.household_id !== scope.householdId || stored.schema_version !== 2) throw new SharingAccessError('共有v2のアカウント・グループが一致しません。');
}

export function createV2EventRepository(database: SQLiteDatabase, options: V2StoreScope & {
  identity: DeviceSecretIdentity; anchor: VerifiedSharedRoster; archive: () => readonly VerifiedSharedRoster[];
  assertWritable: () => void; migration?: VerifiedLegacyMigration; now?: () => Date; afterCommit?: () => void;
}) {
  const clock = options.now ?? (() => new Date());
  let checkedArchive: { digest: string; value: VerifiedSharedRoster[] } | null = null;
  const authenticated = new Map<string, string>();
  function archive() {
    const input = options.archive(); const latest = input.at(-1); if (!latest) throw new SharingAccessError('共有メンバーを確認できません。');
    const digest = sharedRosterDigest(latest);
    if (checkedArchive?.digest !== digest) checkedArchive = { digest, value: verifySharedRosterArchive(options.anchor, input) };
    return checkedArchive.value;
  }
  async function project(transaction: SQLiteDatabase, replica: SharedReplica, localIds?: ReadonlySet<string>) {
    await assertV2Binding(transaction, options);
    if (replica.groupId !== options.groupId) throw new SharingAccessError('共有グループが一致しません。');
    const history = archive(); const latest = history.at(-1)!;
    if (latest.body.schemaVersion !== 2 || latest.body.schedulerVersion !== V2_SCHEDULER_VERSION) throw new SharingSchedulerVersionError();
    sharedAuthorIdentity(latest, options.userId, options.identity.deviceId, latest.body.keyVersion);
    const proofs = new Map((await readSharedFactsInsideTransaction(transaction, options.groupId)).map((fact) => [fact.operation.operationId, fact]));
    const receipts = await readV2ServerReceiptsInside(transaction, options.groupId);
    const retained = new Set(replica.operations.map((operation) => operation.operationId));
    if (replica.operationIndex.some((receipt) => receipt.sequence > (options.migration?.frontier[receipt.deviceId] ?? 0)
      && !retained.has(receipt.operationId))) throw new Error('A v2 snapshot cannot discard authority or business history');
    for (const operation of replica.operations) {
      const fact = proofs.get(operation.operationId);
      if (!fact || canonicalJson(fact.operation) !== canonicalJson(operation)) throw new Error('Missing original v2 author proof');
      const epoch = rosterAtOperation(history, operation);
      const identity = sharedAuthorIdentity(epoch, operation.authorUserId, operation.authorDeviceId, operation.keyVersion);
      const digest = sharedDocumentDigest([operation, fact.authorSignature, identity]);
      if (authenticated.get(operation.operationId) !== digest) {
        verifyAuthenticatedSharedOperation(fact, identity, options.groupId); authenticated.set(operation.operationId, digest);
      }
      const receipt = receipts.get(operation.operationId); if (receipt) bindV2ServerReceipt(receipt, fact, history);
    }
    while (authenticated.size > 50_000) authenticated.delete(authenticated.keys().next().value!);
    const pendingRows = await transaction.getAllAsync<{ operation_id: string }>(`SELECT q.operation_id FROM sharing_outbox q
      JOIN sharing_operations o USING(operation_id) WHERE o.group_id=? AND o.author_device_id=?`, options.groupId, options.identity.deviceId);
    const assessment = assessV2BusinessHistory(replica, history, options.migration, { receipts, facts: proofs, pendingLocalIds: new Set(pendingRows.map((row) => row.operation_id)) });
    const failedLocal = assessment.rejected.find((entry) => localIds?.has(entry.operationId)); if (failedLocal) throw failedLocal.error;
    const accepted = assessment.view.ready.map((operation) => operation.operationId);
    const rejected = assessment.rejected.map((entry) => ({ operationId: entry.operationId, kind: entry.kind,
      reason: 'code' in entry.error ? String(entry.error.code) : 'sharing/v2-invalid-business-fact' }));
    const requestStates = assessment.requestStates;
    const factHash = sharedDocumentDigest({ protocol: 2, projection: 'v2-authority-5',
      sources: digestPages(replica.operations.map((operation) => sharedDocumentDigest(operation))),
      receipts: digestPages([...receipts.values()].map((receipt) => sharedDocumentDigest(receipt))),
      accepted: digestPages(accepted), rejected: digestPages(rejected), provisional: digestPages(assessment.provisionalOperationIds),
      requests: digestPages(requestStates.map(({ decisions, counteroffers, conflictIds, ...state }) => sharedDocumentDigest({ ...state,
        decisions: digestPages(decisions), counteroffers: digestPages(counteroffers), conflictIds: digestPages(conflictIds) }))),
      formalRules: digestPages(assessment.approvedRules.map((rule) => sharedDocumentDigest(rule))),
      roster: sharedRosterDigest(latest) });
    await transaction.runAsync(`INSERT INTO sharing_v2_projection (singleton, fact_hash, accepted_ids_json, rejected_json, pending_ids_json, provisional_ids_json, request_states_json, formal_rules_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(singleton) DO UPDATE SET
      fact_hash=excluded.fact_hash, accepted_ids_json=excluded.accepted_ids_json, rejected_json=excluded.rejected_json,
      pending_ids_json=excluded.pending_ids_json, provisional_ids_json=excluded.provisional_ids_json,
      request_states_json=excluded.request_states_json, formal_rules_json=excluded.formal_rules_json WHERE fact_hash != excluded.fact_hash`, factHash,
    JSON.stringify(accepted), JSON.stringify(rejected), JSON.stringify(replica.pendingOperationIds), JSON.stringify(assessment.provisionalOperationIds), JSON.stringify(requestStates), JSON.stringify(assessment.approvedRules));
    return assessment;
  }
  return {
    scope: Object.freeze({ groupId: options.groupId, userId: options.userId, householdId: options.householdId, deviceId: options.identity.deviceId }),
    readReceiptCache: async (transaction: SQLiteDatabase) => {
      await assertV2Binding(transaction, options); return readV2ServerReceiptsInside(transaction, options.groupId);
    },
    project: async (transaction: SQLiteDatabase, replica: SharedReplica) => { await project(transaction, replica); },
    evidenceForServerReceipts(receipts: readonly V2ServerReceipt[]): SharedLedgerEvidence {
      let stored: ReadonlyMap<string, V2ServerReceipt> = new Map();
      return { record: async (transaction) => {
        await assertV2Binding(transaction, options);
        const changed = await persistV2ServerReceiptsInside(transaction, options.groupId, receipts);
        stored = await readV2ServerReceiptsInside(transaction, options.groupId); return changed;
      }, acknowledge: async (transaction, operation) => {
        if (operation.schemaVersion === 1) return true;
        const receipt = stored.get(operation.operationId); if (!receipt) return false;
        const row = await transaction.getFirstAsync<{ author_signature: string | null }>('SELECT author_signature FROM sharing_operations WHERE operation_id=?', operation.operationId);
        return Boolean(row?.author_signature && receipt.authorProofDigest === v2AuthorProofDigest({ operation, authorSignature: row.author_signature }));
      } };
    },
    async commit(input: readonly SharedOperationDraft[] | ((replica: SharedReplica) => Promise<readonly SharedOperationDraft[]>)): Promise<SharedOperation[]> {
      options.assertWritable(); const latest = archive().at(-1)!; const localIds = new Set<string>();
      if (latest.body.schemaVersion !== 2 || latest.body.schedulerVersion !== V2_SCHEDULER_VERSION) throw new SharingSchedulerVersionError();
      const operationTime = clock();
      const author = { groupId: options.groupId, userId: options.userId, deviceId: options.identity.deviceId,
        keyVersion: latest.body.keyVersion, schemaVersion: 2 as const, now: () => operationTime };
      const created = await createLocalSharedOperations(database, author, async (transaction, replica) => {
        options.assertWritable(); await assertV2Binding(transaction, options);
        if (sharedRosterDigest(archive().at(-1)!) !== sharedRosterDigest(latest)) throw new SharingAccessError('編集開始後に共有権限が変わりました。');
        const drafts = typeof input === 'function' ? await input(replica) : input;
        for (const draft of drafts) localIds.add(draft.operationId); return drafts;
      }, async (transaction, replica) => { options.assertWritable(); await project(transaction, replica, localIds); }, (op) => signSharedOperation(op, options.identity).authorSignature);
      options.afterCommit?.(); return created;
    },
  };
}
