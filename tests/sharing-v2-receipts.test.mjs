import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { Timestamp } from 'firebase/firestore';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation, sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, removeSharedMember, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { validateV2ServerReceipt, v2AuthorProofDigest, bindV2ServerReceipt } from '../src/features/sharing/v2/server-receipts.ts';
import { parseV2FirestoreReceipt } from '../src/platform/sharing/v2-receipts.ts';
import { initializeV2ReceiptTable, persistV2ServerReceiptsInside, readV2ServerReceiptsInside } from '../src/platform/storage/sharing-v2-receipts.ts';
import { withIsolatedSqliteTransaction } from '../src/platform/storage/isolated-transaction.ts';
import { createV2HistoryView } from '../src/features/sharing/v2/history-view.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { validateV2DeliveredAuthority } from '../src/features/sharing/v2/receiver-authority.ts';
import { createGroupPolicy } from '../src/features/sharing/v2/model.ts';

const groupId = 'receipt-group'; const operationId = 'operation-one'; const serverTime = Date.parse('2026-10-27T01:00:00Z');
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const archive = [createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 })]; archive.push(approveSharedDevice(archive[0], owner, 'member', member));
  const fact = signSharedOperation({ schemaVersion: 2, recordedAt: '2030-01-01T00:00:00Z', groupId, operationId, authorUserId: 'member', authorDeviceId: member.deviceId,
    keyVersion: 2, deviceSequence: 1, logicalClock: 1, context: {}, entityType: 'member', entityId: 'member', operationType: 'patch', payload: { displayName: '検査' } }, member);
  const raw = { schemaVersion: 2, authorUserId: 'member', authorDeviceId: member.deviceId, keyVersion: 2, uploadSequence: 1,
    authorProofDigest: v2AuthorProofDigest(fact), createdAt: Timestamp.fromMillis(serverTime) };
  return { owner, member, archive, fact, raw, receipt: parseV2FirestoreReceipt(raw, groupId, operationId) };
}
test('v2 receipts require a committed Firestore timestamp and bind hidden author proof rather than device clock or a plaintext hash', async () => {
  const f = await fixture(); assert.equal(f.receipt.receivedAtMs, serverTime);
  assert.notEqual(v2AuthorProofDigest(f.fact), sharedDocumentDigest(f.fact.operation));
  assert.equal(bindV2ServerReceipt(f.receipt, f.fact, f.archive).body.keyVersion, 2);
  for (const createdAt of [undefined, null, serverTime, '2026-10-27T01:00:00Z', { toMillis: () => serverTime }]) {
    assert.throws(() => parseV2FirestoreReceipt({ ...f.raw, createdAt }, groupId, operationId));
  }
  assert.throws(() => parseV2FirestoreReceipt({ ...f.raw, originalOperationTime: '2020-01-01T00:00:00Z' }, groupId, operationId));
  assert.throws(() => validateV2ServerReceipt({ ...f.receipt, freeBusy: [] }));
});
test('v2 receipts cannot change group, operation, author, proof digest or original membership generation', async () => {
  const f = await fixture();
  for (const patch of [{ groupId: 'other' }, { operationId: 'other' }, { authorUserId: 'owner' }, { authorDeviceId: f.owner.deviceId },
    { authorProofDigest: '0'.repeat(64) }, { receivedKeyVersion: 1 }, { receivedAtMs: 1.5 }]) {
    assert.throws(() => bindV2ServerReceipt({ ...f.receipt, ...patch }, f.fact, f.archive));
  }
  f.archive.push(removeSharedMember(f.archive.at(-1), f.owner, 'member'));
  assert.equal(bindV2ServerReceipt(f.receipt, f.fact, f.archive).body.keyVersion, 2);
  assert.throws(() => bindV2ServerReceipt({ ...f.receipt, receivedKeyVersion: 3 }, f.fact, f.archive), /approved device/);
  assert.throws(() => bindV2ServerReceipt(f.receipt, { ...f.fact, operation: { ...f.fact.operation, payload: { displayName: '改変' } } }, f.archive), /original author proof/);
});
test('v2 receipt storage is idempotent, immutable and transaction-local with rollback on any conflicting evidence', async () => {
  const f = await fixture(); const h = createDatabase();
  try {
    await initializeV2ReceiptTable(h.database);
    const save = (rows) => withIsolatedSqliteTransaction(h.database, (tx) => persistV2ServerReceiptsInside(tx, groupId, rows));
    assert.equal(await save([f.receipt]), true); assert.equal(await save([f.receipt]), false);
    await assert.rejects(save([{ ...f.receipt, operationId: 'new' }, { ...f.receipt, receivedAtMs: serverTime + 1 }]), /immutable/);
    assert.equal((await readV2ServerReceiptsInside(h.database, groupId)).size, 1);
    assert.deepEqual((await readV2ServerReceiptsInside(h.database, groupId)).get(operationId), f.receipt);
    await assert.rejects(save([{ ...f.receipt, groupId: 'another' }]), /Foreign/);
  } finally { h.connection.close(); }
});
test('v2 server delivery checks ownership at original operation and receipt while preserving previously accepted historical authority', async () => {
  const f = await fixture();
  const operation = { ...f.fact.operation, authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
    entityType: 'groupPolicy', entityId: 'policy', payload: { configuration: createGroupPolicy('family') } };
  const fact = signSharedOperation(operation, f.owner);
  const receipt = { ...f.receipt, authorUserId: 'owner', authorDeviceId: f.owner.deviceId, authorProofDigest: v2AuthorProofDigest(fact) };
  const view = createV2HistoryView(buildSharedReplica(groupId, [fact.operation]));
  f.archive.push(transferSharedOwnership(f.archive.at(-1), f.owner, { userId: 'member', deviceId: f.member.deviceId }));
  validateV2DeliveredAuthority(view, f.archive, fact, receipt);
  assert.throws(() => validateV2DeliveredAuthority(view, f.archive, fact, { ...receipt, receivedKeyVersion: 3 }), /administrator/);
  const latePromotion = signSharedOperation({ ...operation, authorUserId: 'member', authorDeviceId: f.member.deviceId }, f.member);
  const promotedReceipt = { ...f.receipt, receivedKeyVersion: 3, authorProofDigest: v2AuthorProofDigest(latePromotion) };
  assert.throws(() => validateV2DeliveredAuthority(view, f.archive, latePromotion, promotedReceipt), /administrator/);
});
test('v2 immutable receipt security cases remain wired into the CI Firestore emulator command alongside all v1 cases', () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const command = packageJson.scripts['test:sharing-cloud'];
  for (const file of ['firestore-rules.integration.mjs', 'sharing-cloud.integration.mjs', 'sharing-flow.integration.mjs', 'sharing-v2-cloud.integration.mjs']) assert.ok(command.includes(`tests/${file}`));
  const source = readFileSync(new URL('./sharing-v2-cloud.integration.mjs', import.meta.url), 'utf8');
  for (const title of ['v2 cloud commits immutable server receipts', 'v2 Rules deny forged receipt clocks',
    'v2 compacted events retain their original server receipt', 'v2 Rules require an explicit owner-preserving protocol upgrade snapshot']) assert.ok(source.includes(title));
  assert.ok(readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8').includes('npm run test:sharing-cloud'));
});
