import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { readFileSync } from 'node:fs';
import { initializeTestEnvironment, assertFails } from '@firebase/rules-unit-testing';
import { doc, getDocFromServer, setDoc, updateDoc, deleteDoc, serverTimestamp, Timestamp, writeBatch } from 'firebase/firestore';
import { createSharingCloud } from '../src/platform/sharing/firestore-cloud.ts';
import { createDeviceIdentity, encryptSharedOperation, signSharedOperation, wrapGroupKey } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, upgradeSharedRoster, sharedAuthorIdentity } from '../src/features/sharing/roster.ts';
import { v2AuthorProofDigest, bindV2ServerReceipt } from '../src/features/sharing/v2/server-receipts.ts';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';
import { createEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';

if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('Run v2 cloud tests only against the local emulator.');
let environment;
before(async () => { environment = await initializeTestEnvironment({ projectId: 'demo-liflow-sharing',
  firestore: { rules: readFileSync(new URL('../firestore.rules', import.meta.url), 'utf8') } }); });
beforeEach(async () => { await environment.clearFirestore(); });
after(async () => { await environment?.cleanup(); });
const groupId = 'v2-cloud-group';
async function fixture(schemaVersion = 2) {
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const store = environment.authenticatedContext('owner').firestore(); let active = 'owner';
  const cloud = createSharingCloud(store, 'owner', () => active);
  const roster = createSharedRoster(groupId, 'owner', identity, { schemaVersion });
  const wrapped = await wrapGroupKey(crypto, groupId, 1, key, identity, identity, 'owner');
  await cloud.createGroup(roster, wrapped);
  const make = async (sequence, patch = {}) => {
    const operation = { schemaVersion: 2, recordedAt: '2030-01-01T00:00:00Z', groupId, operationId: `operation-${sequence}`,
      authorUserId: 'owner', authorDeviceId: identity.deviceId, keyVersion: 1, deviceSequence: sequence, logicalClock: sequence,
      context: sequence > 1 ? { [identity.deviceId]: sequence - 1 } : {}, entityType: 'chore', entityId: 'floor', operationType: 'patch',
      payload: { name: `秘密のv2家事 ${sequence}` }, ...patch };
    const fact = signSharedOperation(operation, identity);
    return { fact, envelope: await encryptSharedOperation(crypto, operation, key, identity), authorProofDigest: v2AuthorProofDigest(fact) };
  };
  return { identity, key, roster, store, cloud, make, root: doc(store, 'sharingGroups', groupId), switchAccount: () => { active = 'another'; } };
}

test('v2 cloud commits immutable server receipts with encrypted events, bounds receipt recovery and keeps the same original timestamp on retry', async () => {
  const f = await fixture(); const facts = []; let first;
  for (let sequence = 1; sequence <= 205; sequence++) {
    const item = await f.make(sequence); facts.push(item.fact);
    const sent = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
    assert.equal(sent.serverReceipt.uploadSequence, sequence); assert.equal(sent.serverReceipt.receivedKeyVersion, 1);
    bindV2ServerReceipt(sent.serverReceipt, item.fact, [f.roster]);
    assert.ok(Math.abs(sent.serverReceipt.receivedAtMs - Date.now()) < 60_000);
    if (sequence === 1) {
      first = sent; const retry = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
      assert.deepEqual(retry.serverReceipt, sent.serverReceipt);
    }
  }
  const recovered = await f.cloud.readReceipts(groupId, facts.map((fact) => fact.operation.operationId));
  assert.equal(recovered.length, 205); assert.deepEqual(recovered.find((receipt) => receipt.operationId === 'operation-1'), first.serverReceipt);
  const page = await f.cloud.pull(groupId, 0); const second = await f.cloud.pull(groupId, 100); const third = await f.cloud.pull(groupId, 200);
  assert.deepEqual([page.events.length, second.events.length, third.events.length], [100, 100, 5]);
  assert.deepEqual(page.events[0].serverReceipt, first.serverReceipt);
  const raw = (await getDocFromServer(doc(f.root, 'receipts', 'operation-1'))).data();
  assert.deepEqual(Object.keys(raw).sort(), ['authorDeviceId', 'authorProofDigest', 'authorUserId', 'createdAt', 'keyVersion', 'schemaVersion', 'uploadSequence']);
  assert.equal(JSON.stringify(raw).includes('秘密'), false); assert.equal(JSON.stringify(raw).includes('authorSignature'), false);
  await assert.rejects(f.cloud.readReceipts(groupId, Array.from({ length: 1001 }, (_, index) => `id-${index}`)));
  f.switchAccount(); await assert.rejects(f.cloud.readReceipts(groupId, ['operation-1']), /切り替わり/);
});
test('v2 Rules deny forged receipt clocks, missing or mismatched paired receipts, other accounts and receipt rewrites or removal', async () => {
  const f = await fixture();
  async function forged({ omitReceipt = false, eventChange = {}, receiptChange = {}, updateRoot = true } = {}) {
    const event = { schemaVersion: 2, authorUserId: 'owner', authorDeviceId: f.identity.deviceId, keyVersion: 1,
      uploadSequence: 1, envelopeJson: 'ciphertext-only', authorProofDigest: 'a'.repeat(64), createdAt: serverTimestamp(), ...eventChange };
    const { envelopeJson: _encrypted, ...receipt } = event;
    const batch = writeBatch(f.store); batch.set(doc(f.root, 'events', 'forged'), event);
    if (!omitReceipt) batch.set(doc(f.root, 'receipts', 'forged'), { ...receipt, ...receiptChange });
    if (updateRoot) batch.update(f.root, { headSequence: 1, lastOperationId: 'forged', updatedAt: serverTimestamp() });
    return batch.commit();
  }
  await assertFails(forged({ omitReceipt: true }));
  await assertFails(forged({ eventChange: { createdAt: Timestamp.fromMillis(1000) }, receiptChange: { createdAt: Timestamp.fromMillis(1000) } }));
  await assertFails(forged({ receiptChange: { authorProofDigest: 'b'.repeat(64) } }));
  await assertFails(forged({ updateRoot: false }));
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 0);
  const item = await f.make(1); await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const ref = doc(f.root, 'receipts', item.fact.operation.operationId);
  await assertFails(updateDoc(ref, { createdAt: serverTimestamp() })); await assertFails(deleteDoc(ref));
  await assertFails(getDocFromServer(doc(environment.authenticatedContext('outsider').firestore(), 'sharingGroups', groupId, 'receipts', 'operation-1')));
  await assertFails(setDoc(doc(f.root, 'receipts', 'unpaired'), { ...(await getDocFromServer(ref)).data(), createdAt: serverTimestamp() }));
});
test('v2 compacted events retain their original server receipt and retry requests a verified snapshot rather than recreating an acceptance time', async () => {
  const f = await fixture(); const item = await f.make(1); const accepted = await f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest });
  const replica = buildSharedReplica(groupId, [item.fact.operation]);
  const snapshot = await createEncryptedSharedSnapshot(crypto, replica, [item.fact], f.roster, f.identity, f.key, 'v2-compact', 1,
    (uid, device, version) => sharedAuthorIdentity(f.roster, uid, device, version));
  await f.cloud.prepareSnapshot(snapshot, f.roster); await f.cloud.publishSnapshot(snapshot.manifest, f.roster);
  await deleteDoc(doc(f.root, 'events', 'operation-1'));
  await assert.rejects(f.cloud.upload(item.envelope, { authorProofDigest: item.authorProofDigest }), { code: 'sharing/snapshot-required' });
  assert.deepEqual((await f.cloud.readReceipts(groupId, ['operation-1']))[0], accepted.serverReceipt);
  assert.equal((await getDocFromServer(f.root)).data().headSequence, 1);
});
test('v2 Rules require an explicit owner-preserving protocol upgrade snapshot and prevent downgrade', async () => {
  const f = await fixture(1); const next = upgradeSharedRoster(f.roster, f.identity);
  const fields = (await import('../src/features/sharing/cloud-contract.ts')).rosterCloudFields(next);
  const snapshotId = 'upgrade-snapshot';
  const mutate = async (extra = {}, includeSnapshot = false) => {
    const batch = writeBatch(f.store);
    batch.update(f.root, { ...fields, snapshotId, snapshotThroughSequence: 0, updatedAt: serverTimestamp(), ...extra });
    batch.set(doc(f.root, 'rosters', '2'), { rosterJson: fields.rosterJson, createdAt: serverTimestamp() });
    if (includeSnapshot) batch.set(doc(f.root, 'snapshots', snapshotId), { keyVersion: 2, throughSequence: 0, manifestJson: 'signed-encrypted-v2-manifest', createdAt: serverTimestamp() });
    return batch.commit();
  };
  await assertFails(mutate());
  await assertFails(mutate({ ownerUserId: 'outsider', memberIds: ['outsider'], deviceOwners: { [f.identity.deviceId]: 'outsider' } }, true));
  await mutate({}, true);
  const batch = writeBatch(f.store); batch.update(f.root, { schemaVersion: 1, keyVersion: 3, rosterRevision: 3, rosterJson: 'downgrade', updatedAt: serverTimestamp() });
  batch.set(doc(f.root, 'rosters', '3'), { rosterJson: 'downgrade', createdAt: serverTimestamp() });
  await assertFails(batch.commit());
});
