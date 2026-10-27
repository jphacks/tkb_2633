import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createDeviceIdentity, signSharedOperation } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, sharedAuthorIdentity, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2AuthorProofDigest } from '../src/features/sharing/v2/server-receipts.ts';
import { v2OccurrenceId, v2DatePermissionId } from '../src/features/sharing/v2/occurrence-id.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox, applyReceivedSharedFacts, readSharingCheckpoint, applySharingSnapshot } from '../src/platform/storage/sharing-ledger.ts';
import { createEncryptedSharedSnapshot, openEncryptedSharedSnapshot } from '../src/features/sharing/snapshots.ts';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
const { ensureLocalHousehold } = await import('../src/platform/storage/repository.ts');

const groupId = 'v2-repository'; const scope = { groupId, userId: 'owner', householdId: 'group-local' };
const now = () => new Date('2026-10-27T01:00:00Z');
const receiptsFor = (facts) => facts.map((fact) => ({ schemaVersion: 2, groupId,
  operationId: fact.operation.operationId, authorUserId: fact.operation.authorUserId, authorDeviceId: fact.operation.authorDeviceId,
  receivedKeyVersion: fact.operation.keyVersion, uploadSequence: fact.operation.logicalClock,
  authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: now().getTime() }));
const draft = (operationId, entityType, entityId, payload) => ({ operationId, entityType, entityId, payload, operationType: 'patch' });
const seeds = () => [
  draft('policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('family') }),
  draft('settings', 'settings', 'settings', { name: '検査グループ', timeZone: 'Asia/Tokyo', anchorDate: '2026-10-27' }),
  draft('floor', 'chore', 'floor', { name: '床を掃除する', enabled: true }),
  draft('configuration', 'chorePolicy', 'floor', { configuration: { policy: chorePolicyFromPreset('common'), anchorDate: '2026-10-27',
    intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 } }),
];
async function fixture() {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const archive = [createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 })]; archive.push(approveSharedDevice(archive[0], owner, 'member', member));
  async function device(userId = 'owner', identity = owner) {
    const h = createDatabase(); await initializeV2EventStore(h.database, { ...scope, userId });
    let writable = true;
    const options = { ...scope, userId, identity, anchor: archive[0], archive: () => archive, now, assertWritable: () => { if (!writable) throw new Error('account changed'); } };
    const repository = createV2EventRepository(h.database, options);
    return { ...h, repository, options, stopWrites: () => { writable = false; },
      state: () => { const row = h.connection.prepare('SELECT * FROM sharing_v2_projection').get(); return row ? {
        accepted: JSON.parse(row.accepted_ids_json), rejected: JSON.parse(row.rejected_json), pending: JSON.parse(row.pending_ids_json), hash: row.fact_hash } : null; } };
  }
  return { owner, member, archive, device };
}

test('v2 repository binds a fresh database and preserves every personal table and v1 workspace without in-place conversion', async () => {
  const personal = createDatabase(); const legacy = createDatabase();
  const dump = (h) => ({ schema: h.connection.prepare("SELECT name, sql FROM sqlite_master ORDER BY name").all(),
    version: h.connection.prepare('PRAGMA user_version').get(),
    rows: Object.fromEntries(h.connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
      .map(({ name }) => [name, h.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all().sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))])) });
  try {
    await migrateLocalDatabase(personal.database); await ensureLocalHousehold(personal.database);
    const before = dump(personal); await assert.rejects(initializeV2EventStore(personal.database, scope), /個人DB/); assert.deepEqual(dump(personal), before);
    await initializeSharedProjection(legacy.database, scope); const legacyBefore = dump(legacy);
    await assert.rejects(initializeV2EventStore(legacy.database, scope), /separate v2 database/); assert.deepEqual(dump(legacy), legacyBefore);
  } finally { personal.connection.close(); legacy.connection.close(); }
  const f = await fixture(); const d = await f.device();
  try {
    await initializeV2EventStore(d.database, scope);
    await assert.rejects(initializeV2EventStore(d.database, { ...scope, userId: 'another-user' }), { code: 'sharing/access-denied' });
    assert.equal(d.connection.prepare('SELECT user_id FROM sharing_v2_binding').get().user_id, 'owner');
  } finally { d.connection.close(); }
});
test('v2 local repository atomically signs operations and outbox, retains original times on retry and resumes after restart', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    const created = await d.repository.commit(seeds()); assert.equal(created.length, 4);
    assert.ok(created.every((op) => op.recordedAt === now().toISOString())); assert.equal((await listSharingOutbox(d.database, groupId)).length, 4);
    const before = d.state(); const restart = createV2EventRepository(d.database, { ...d.options, now: () => new Date('2026-10-28T00:00:00Z') });
    const retry = await restart.commit(seeds()); assert.deepEqual(retry, created); assert.deepEqual(d.state(), before);
    await assert.rejects(restart.commit([draft('configuration', 'chorePolicy', 'floor', { configuration: {} })]));
    assert.equal((await listSharingOutbox(d.database, groupId)).length, 4); assert.equal(d.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    d.stopWrites(); await assert.rejects(restart.commit([draft('new', 'chore', 'floor', { name: '変更' })]), /account changed/);
  } finally { d.connection.close(); }
});
test('v2 receive quarantines signed unauthorized edits and their forged privileges but commits independent changes and receive position', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const initial = await loadSharedFacts(owner.database, groupId);
    await applyReceivedSharedFacts(member.database, groupId, initial, '4', member.repository.project, null,
      now().getTime(), member.repository.evidenceForServerReceipts(receiptsFor(initial)));
    const before = member.state();
    await assert.rejects(member.repository.commit([draft('forbidden-local', 'chore', 'floor', { enabled: false })]), { code: 'sharing/v2-authority-denied' });
    assert.deepEqual(member.state(), before); assert.equal((await listSharingOutbox(member.database, groupId)).length, 0);
    const [valid] = await member.repository.commit([draft('valid-local', 'chore', 'floor', { name: '床掃除' })]); assert.equal(valid.deviceSequence, 1);
    const context = { [f.owner.deviceId]: 4 };
    const invalid = signSharedOperation({ schemaVersion: 2, recordedAt: now().toISOString(), operationId: 'forbidden-remote', groupId,
      authorUserId: 'member', authorDeviceId: f.member.deviceId, keyVersion: 2, deviceSequence: 1, logicalClock: 5, context,
      entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { enabled: false } }, f.member);
    const independent = signSharedOperation({ ...invalid.operation, operationId: 'independent-remote', deviceSequence: 2,
      logicalClock: 6, context: { ...context, [f.member.deviceId]: 1 }, payload: { instructions: ['ほこりを取る'] } }, f.member);
    await applyReceivedSharedFacts(owner.database, groupId, [independent, invalid], '6', owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts(receiptsFor([...initial, invalid, independent])));
    assert.deepEqual(owner.state().rejected.map((op) => op.operationId), ['forbidden-remote']);
    assert.ok(owner.state().accepted.includes('independent-remote')); assert.equal((await readSharingCheckpoint(owner.database, groupId)).sequence, 6);
    assert.ok((await loadSharedReplica(owner.database, groupId)).operations.some((op) => op.operationId === 'forbidden-remote'));
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 projection rejects missing or altered original author proofs before changing derived state or cursor', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const facts = await loadSharedFacts(owner.database, groupId);
    const tampered = facts.map((fact, index) => index === 2 ? { ...fact, authorSignature: '0'.repeat(128) } : fact);
    await assert.rejects(applyReceivedSharedFacts(receiver.database, groupId, tampered, '4', receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receiptsFor(facts))));
    assert.equal(receiver.state(), null); assert.equal((await readSharingCheckpoint(receiver.database, groupId)).cursor, null);
    assert.equal((await loadSharedReplica(receiver.database, groupId)).operations.length, 0);
    await applyReceivedSharedFacts(receiver.database, groupId, facts, '4', receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal(receiver.state().accepted.length, 4);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 encrypted snapshots retain original proofs, restore authority state and refuse manifest protocol tampering', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const replica = await loadSharedReplica(owner.database, groupId); const facts = await loadSharedFacts(owner.database, groupId);
    const resolve = (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version); const key = await crypto.randomBytes(32);
    const receipts = receiptsFor(facts);
    await applyReceivedSharedFacts(owner.database, groupId, facts, '4', owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts(receipts));
    const encrypted = await createEncryptedSharedSnapshot(crypto, replica, facts, f.archive.at(-1), f.owner, key, 'snapshot-v2', 4, resolve);
    assert.equal(encrypted.manifest.body.schemaVersion, 2);
    const opened = await openEncryptedSharedSnapshot(crypto, encrypted, key, f.archive.at(-1), resolve);
    const erased = { ...opened, base: { ...opened.base, operations: opened.base.operations.slice(1) }, facts: opened.facts.slice(1) };
    await assert.rejects(applySharingSnapshot(receiver.database, groupId, erased, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receipts)), /cannot discard/);
    assert.equal(receiver.state(), null); assert.equal((await readSharingCheckpoint(receiver.database, groupId)).cursor, null);
    await applySharingSnapshot(receiver.database, groupId, opened, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts(receipts));
    assert.deepEqual(receiver.state(), owner.state()); assert.deepEqual((await loadSharedReplica(receiver.database, groupId)).frontier, replica.frontier);
    await assert.rejects(openEncryptedSharedSnapshot(crypto, { ...encrypted, manifest: { ...encrypted.manifest, body: { ...encrypted.manifest.body, schemaVersion: 1 } } },
      key, f.archive.at(-1), resolve), /manifest/);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 snapshots without independent server receipts remain unconfirmed and cannot acknowledge the original offline outbox', async () => {
  const f = await fixture(); const owner = await f.device(); const receiver = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const replica = await loadSharedReplica(owner.database, groupId); const facts = await loadSharedFacts(owner.database, groupId);
    const key = await crypto.randomBytes(32); const resolve = (uid, device, version) => sharedAuthorIdentity(f.archive[version - 1], uid, device, version);
    const sealed = await createEncryptedSharedSnapshot(crypto, replica, facts, f.archive.at(-1), f.owner, key, 'without-receipts', 4, resolve);
    const snapshot = await openEncryptedSharedSnapshot(crypto, sealed, key, f.archive.at(-1), resolve);
    await applySharingSnapshot(receiver.database, groupId, snapshot, receiver.repository.project, null,
      now().getTime(), receiver.repository.evidenceForServerReceipts([]));
    assert.equal(receiver.state().accepted.length, 0); assert.equal(receiver.state().rejected.length, 4);
    assert.ok(receiver.state().rejected.every((entry) => entry.kind === 'unconfirmed'));
    await applySharingSnapshot(owner.database, groupId, snapshot, owner.repository.project, null,
      now().getTime(), owner.repository.evidenceForServerReceipts([]));
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 4);
    assert.equal(owner.connection.prepare('SELECT COUNT(*) AS count FROM sharing_operations').get().count, 4);
    await applyReceivedSharedFacts(owner.database, groupId, facts, '4', owner.repository.project, '4',
      now().getTime(), owner.repository.evidenceForServerReceipts(receiptsFor(facts)));
    assert.equal((await listSharingOutbox(owner.database, groupId)).length, 0);
    assert.equal(JSON.parse(owner.connection.prepare('SELECT provisional_ids_json FROM sharing_v2_projection').get().provisional_ids_json).length, 0);
  } finally { owner.connection.close(); receiver.connection.close(); }
});
test('v2 delayed former-administrator edits lose privileged effects at server delivery without erasing original facts or ordinary member edits', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const original = await loadSharedFacts(d.database, groupId);
    await d.repository.commit([draft('old-admin-policy', 'groupPolicy', 'policy', { configuration: createGroupPolicy('roommates') }),
      draft('ordinary-name', 'chore', 'floor', { name: '説明の訂正' })]);
    const facts = await loadSharedFacts(d.database, groupId);
    f.archive.push(transferSharedOwnership(f.archive.at(-1), f.owner, { userId: 'member', deviceId: f.member.deviceId }));
    const receipts = receiptsFor(facts).map((receipt) => ['old-admin-policy', 'ordinary-name'].includes(receipt.operationId)
      ? { ...receipt, receivedKeyVersion: 3 } : receipt);
    await applyReceivedSharedFacts(d.database, groupId, facts, '6', d.repository.project, null,
      now().getTime(), d.repository.evidenceForServerReceipts(receipts));
    assert.deepEqual(d.state().rejected.map((entry) => entry.operationId), ['old-admin-policy']);
    assert.ok(d.state().accepted.includes('ordinary-name')); assert.ok(d.state().accepted.includes(original[0].operation.operationId));
    assert.equal((await loadSharedFacts(d.database, groupId)).length, 6); assert.equal((await listSharingOutbox(d.database, groupId)).length, 0);
  } finally { d.connection.close(); }
});
test('v2 receipt recovery refuses another user database before any partial progress write', async () => {
  const f = await fixture(); const owner = await f.device(); const member = await f.device('member', f.member);
  try {
    await owner.repository.commit(seeds()); const receipts = receiptsFor(await loadSharedFacts(owner.database, groupId));
    await assert.rejects(owner.repository.readReceiptCache(member.database), { code: 'sharing/access-denied' });
    await assert.rejects(owner.repository.evidenceForServerReceipts(receipts).record(member.database), { code: 'sharing/access-denied' });
    assert.equal(member.connection.prepare('SELECT COUNT(*) AS count FROM sharing_v2_server_receipts').get().count, 0);
    assert.equal(member.state(), null);
  } finally { owner.connection.close(); member.connection.close(); }
});
test('v2 server order prevents predicted future grants from retroactively authorizing a signed date change while later legitimate changes still work', async () => {
  const f = await fixture(); const d = await f.device();
  try {
    await d.repository.commit(seeds()); const initial = await loadSharedFacts(d.database, groupId);
    await applyReceivedSharedFacts(d.database, groupId, initial, '4', d.repository.project, null, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(initial)));
    const base = { schemaVersion: 2, recordedAt: now().toISOString(), groupId, keyVersion: 2, operationType: 'patch' };
    const configuration = (id) => ({ id, choreId: 'floor', subjectUserId: null, referenceAnchorDate: '2026-10-27', timeZoneAtCreation: 'Asia/Tokyo',
      selector: { scope: 'once', occurrenceId: v2OccurrenceId(groupId, 'floor', '2026-10-27'), anchorDate: '2026-10-27' },
      mode: 'day', target: { precision: 'date', date: '2026-10-28' }, strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'member', ruleVersion: 1 });
    const grant = signSharedOperation({ ...base, operationId: 'future-grant', authorUserId: 'owner', authorDeviceId: f.owner.deviceId,
      deviceSequence: 5, logicalClock: 5, context: { [f.owner.deviceId]: 4 }, entityType: 'datePermission', entityId: v2DatePermissionId(groupId, 'floor', 'member'),
      payload: { choreId: 'floor', userId: 'member', enabled: true, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: false } } }, f.owner);
    const predicted = signSharedOperation({ ...base, operationId: 'predicted', authorUserId: 'member', authorDeviceId: f.member.deviceId,
      deviceSequence: 1, logicalClock: 6, context: { [f.owner.deviceId]: 5 }, entityType: 'designation', entityId: 'predicted', payload: { configuration: configuration('predicted') } }, f.member);
    const [predictionReceipt] = receiptsFor([predicted]).map((receipt) => ({ ...receipt, uploadSequence: 5 }));
    const [grantReceipt] = receiptsFor([grant]).map((receipt) => ({ ...receipt, uploadSequence: 6 }));
    await applyReceivedSharedFacts(d.database, groupId, [predicted], '5', d.repository.project, '4', now().getTime(), d.repository.evidenceForServerReceipts([predictionReceipt]));
    assert.ok(!d.state().accepted.includes('predicted'));
    await applyReceivedSharedFacts(d.database, groupId, [grant], '6', d.repository.project, '5', now().getTime(), d.repository.evidenceForServerReceipts([grantReceipt]));
    assert.deepEqual(d.state().rejected, [{ operationId: 'predicted', kind: 'unauthorized', reason: 'sharing/v2-receipt-causality' }]);
    const legitimate = signSharedOperation({ ...predicted.operation, operationId: 'legitimate', entityId: 'legitimate', deviceSequence: 2,
      logicalClock: 7, context: { [f.owner.deviceId]: 5, [f.member.deviceId]: 1 }, payload: { configuration: configuration('legitimate') } }, f.member);
    await applyReceivedSharedFacts(d.database, groupId, [legitimate], '7', d.repository.project, '6', now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor([legitimate])));
    assert.ok(d.state().accepted.includes('legitimate')); assert.ok(d.state().accepted.includes('future-grant'));
  } finally { d.connection.close(); }
});
