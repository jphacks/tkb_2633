import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { validateSharedOperation } from '../src/features/sharing/operations.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { createDeviceIdentity, encryptSharedOperation, decryptSharedOperation, signSharedOperation, signSharedDocument, validateDevicePublicIdentity, verifyAuthenticatedSharedOperation } from '../src/features/sharing/crypto.ts';
import { createLocalSharedOperations, initializeSharingLedger, loadSharedReplica, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
import { compactSharedReplica, buildSharedReplica } from '../src/features/sharing/replica.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { createSharedPlannerRepository } from '../src/platform/storage/shared-planner-repository.ts';
import { createSharedRoster, upgradeSharedRoster, approveSharedDevice, transferSharedOwnership, validateSharedRoster, verifySharedRosterTransition, sharedRosterDigest } from '../src/features/sharing/roster.ts';
import { parseSharedCloudEvent, parseSharedCloudGroup, rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { verifyCloudMembership } from '../src/features/sharing/synchronizer.ts';
import { v2OccurrenceId, v2SubjectOccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';

const groupId = 'group-v2-test'; const recordedAt = '2026-10-27T10:00:00Z';
const scope = { groupId, userId: 'owner', deviceId: 'device-a', keyVersion: 1, schemaVersion: 2, recordedAt };
const draft = (id, entityType, payload, entityId = id) => ({ operationId: id, entityType, entityId, operationType: 'patch', payload });
const operation = (change, overrides = {}) => ({ ...change, schemaVersion: 2, groupId, authorUserId: 'owner', authorDeviceId: 'device-a',
  keyVersion: 1, deviceSequence: 1, logicalClock: 1, context: {}, receiptContext: {}, recordedAt, ...overrides });
const policyDraft = () => draft('policy-one', 'groupPolicy', { configuration: createGroupPolicy('family') }, 'policy');
const rule = (id = 'day-rule') => ({ id, choreId: 'floor', subjectUserId: null, selector: { scope: 'once', occurrenceId: 'floor.2026-10-27', anchorDate: '2026-10-27' },
  referenceAnchorDate: '2026-10-27', timeZoneAtCreation: 'Asia/Tokyo', mode: 'day', target: { precision: 'date', date: '2026-10-27' }, strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'owner', ruleVersion: 1 });

test('v2 event allowlists retain explicit versions and original times while schema1 rejects all v2 fields and entities', () => {
  const value = operation(policyDraft());
  assert.deepEqual(validateSharedOperation(value), value);
  assert.throws(() => validateSharedOperation({ ...value, schemaVersion: 1 }));
  const confirmed = { ...value, receiptContext: { ...value.context } }; assert.deepEqual(validateSharedOperation(confirmed).receiptContext, value.context);
  assert.throws(() => validateSharedOperation({ ...value, receiptContext: { [value.authorDeviceId]: value.deviceSequence } }));
  assert.throws(() => validateSharedOperation({ ...value, receiptContext: { invented: 1 } }));
  assert.throws(() => validateSharedOperation({ ...value, receiptContext: null }));
  const { recordedAt: _recorded, ...withoutTime } = value;
  assert.throws(() => validateSharedOperation(withoutTime));
  const { receiptContext: _receipts, ...withoutReceipts } = value; assert.throws(() => validateSharedOperation(withoutReceipts));
  assert.throws(() => validateSharedOperation({ ...value, schemaVersion: 3 }));
  const original = operation(draft('old', 'chore', { name: '床掃除' }), { schemaVersion: 1 });
  assert.throws(() => validateSharedOperation(original), /Unknown operation field/);
  delete original.recordedAt; delete original.receiptContext; assert.deepEqual(validateSharedOperation(original), original);
  assert.throws(() => validateSharedOperation({ ...value, recordedAt: '2026-10-27T10:00:00' }));
});
test('v2 events refuse private information, impersonated claims, rewritten facts and unknown policy extensions', () => {
  const value = operation(policyDraft());
  for (const [name, data] of [['freeBusy', []], ['googleTaskId', 'private-task'], ['accessToken', 'private-token'], ['personalChores', []]]) {
    assert.throws(() => validateSharedOperation({ ...value, payload: { ...value.payload, [name]: data } }));
  }
  assert.throws(() => validateSharedOperation({ ...value, payload: { configuration: { ...value.payload.configuration, administrator: 'outsider' } } }));
  assert.throws(() => validateSharedOperation(operation(draft('claim-a', 'claim', { choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: 'floor.2026-10-27', userId: 'another-user' }))));
  assert.throws(() => validateSharedOperation(operation(draft('claim-a', 'claim', { choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: 'floor.2026-10-27', userId: 'owner' }, 'older-fact'))));
  assert.throws(() => validateSharedOperation({ ...value, operationType: 'delete', payload: {} }));
  const changed = rule(); changed.issuerUserId = 'another-user';
  assert.throws(() => validateSharedOperation(operation(draft('day-rule', 'designation', { configuration: changed }))));
});
test('v2 policy, date rule, request and completion payloads validate their dependent fields together', () => {
  const config = { policy: chorePolicyFromPreset('eachMember'), anchorDate: '2026-10-27', intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 };
  assert.ok(validateSharedOperation(operation(draft('configure', 'chorePolicy', { configuration: config }, 'floor'))));
  assert.throws(() => validateSharedOperation(operation(draft('configure', 'chorePolicy', { configuration: { ...config, policy: { ...config.policy, assignment: { mode: 'open', memberIds: [] } } } }, 'floor'))));
  assert.ok(validateSharedOperation(operation(draft('day-rule', 'designation', { configuration: rule() }))));
  assert.throws(() => validateSharedOperation(operation(draft('day-rule', 'designation', { configuration: { ...rule(), mode: 'fixed' } }))));
  const request = { requesterUserId: 'owner', choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: 'floor.2026-10-27', subjectUserId: null, originalDesignationId: null,
    original: { precision: 'date', date: '2026-10-27' }, proposed: { precision: 'date', date: '2026-10-28' }, proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: 'floor.2026-10-27', anchorDate: '2026-10-27' }, extensionScope: 'once' };
  assert.ok(validateSharedOperation(operation(draft('request', 'changeRequest', request))));
  assert.throws(() => validateSharedOperation(operation(draft('request', 'changeRequest', { ...request, serverRequestedAt: recordedAt }))));
  const completion = { ...operation(draft('completed', 'completion', { choreId: 'floor', anchorDate: '2026-10-27', completedAt: '2026-10-25T10:00:00Z', completedByMemberId: 'owner',
    subjectUserId: null, originalAssigneeIds: ['owner'], ruleVersion: 1, outcome: 'completed' }, 'floor.2026-10-27')), operationType: 'complete' };
  assert.ok(validateSharedOperation(completion));
  assert.throws(() => validateSharedOperation({ ...completion, payload: { ...completion.payload, completedAt: '2026-10-28T00:00:00Z' } }));
  assert.throws(() => validateSharedOperation({ ...completion, payload: { ...completion.payload, acceptance: 'accepted' } }));
});
test('v2 encryption authenticates the business schema and preserves original signatures and operation time', async () => {
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const value = operation(policyDraft(), { authorDeviceId: identity.deviceId });
  const signed = signSharedOperation(value, identity); assert.deepEqual(verifyAuthenticatedSharedOperation(signed, identity).operation, value);
  const encrypted = await encryptSharedOperation(crypto, value, key, identity);
  assert.equal(encrypted.schemaVersion, 2);
  assert.deepEqual(await decryptSharedOperation(crypto, encrypted, key, identity, groupId, 1), value);
  await assert.rejects(decryptSharedOperation(crypto, { ...encrypted, schemaVersion: 1 }, key, identity, groupId, 1));
  assert.throws(() => parseSharedCloudEvent(value.operationId, { schemaVersion: 1, authorUserId: 'owner', authorDeviceId: identity.deviceId,
    keyVersion: 1, uploadSequence: 1, envelopeJson: JSON.stringify(encrypted) }, groupId));
  assert.equal(parseSharedCloudEvent(value.operationId, { schemaVersion: 2, authorUserId: 'owner', authorDeviceId: identity.deviceId,
    keyVersion: 1, uploadSequence: 1, authorProofDigest: 'a'.repeat(64), envelopeJson: JSON.stringify(encrypted) }, groupId).envelope.schemaVersion, 2);
});
test('v2 signed roster upgrades preserve every approved device, rotate epochs and cannot downgrade or hide behind schema1 metadata', async () => {
  const owner = await createDeviceIdentity(crypto); const member = await createDeviceIdentity(crypto);
  const old = approveSharedDevice(createSharedRoster(groupId, 'owner', owner), owner, 'member', member);
  const next = upgradeSharedRoster(old, owner);
  assert.equal(old.body.schemaVersion, 1); assert.equal(next.body.schemaVersion, 2);
  assert.equal(next.body.keyVersion, old.body.keyVersion + 1); assert.equal(next.body.schedulerVersion, 'liflow-shared-2-draft-10');
  assert.deepEqual(next.body.members, old.body.members);
  const fields = { ...rosterCloudFields(next), headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 };
  assert.equal(parseSharedCloudGroup(fields, groupId).group.schemaVersion, 2);
  assert.throws(() => parseSharedCloudGroup({ ...fields, schemaVersion: 1 }, groupId));
  const signed = (body) => validateSharedRoster({ body, signer: validateDevicePublicIdentity(owner),
    signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, owner) });
  assert.throws(() => verifySharedRosterTransition(old, signed({ ...next.body, members: next.body.members.filter((item) => item.userId === 'owner') })), /preserve/);
  const transferred = transferSharedOwnership(next, owner, { userId: 'member', deviceId: member.deviceId });
  assert.equal(transferred.body.schemaVersion, 2);
  const downgradeBody = { ...next.body, schemaVersion: 1, schedulerVersion: 'liflow-shared-1' };
  assert.throws(() => verifySharedRosterTransition(next, signed({ ...downgradeBody, revision: next.body.revision + 1,
    keyVersion: next.body.keyVersion + 1, previousDigest: sharedRosterDigest(next) })), /downgraded/);
  assert.throws(() => upgradeSharedRoster(next, owner));
  assert.throws(() => upgradeSharedRoster(old, member));
});
test('v1 synchronization stops before saving or processing a correctly signed schema2 roster', async () => {
  const owner = await createDeviceIdentity(crypto); const roster = createSharedRoster(groupId, 'owner', owner, { schemaVersion: 2 });
  let saved = 0;
  const dependencies = { groupId, userId: 'owner', readRecord: async () => ({ groupId, userId: 'owner', status: 'active',
    anchor: roster, rosterArchive: [roster] }), saveArchive: async () => { saved++; }, cloud: {} };
  await assert.rejects(verifyCloudMembership(dependencies, roster), { code: 'sharing/scheduler-version-mismatch' });
  assert.equal(saved, 0);
});
test('v2 compaction retains superseded policies and permissions needed to audit authority at the original causal cut', () => {
  const first = operation(policyDraft());
  const second = operation(draft('policy-two', 'groupPolicy', { configuration: createGroupPolicy('roommates') }, 'policy'),
    { deviceSequence: 2, logicalClock: 2, context: { 'device-a': 1 } });
  const replica = buildSharedReplica(groupId, [second, first]);
  const snapshot = compactSharedReplica(replica);
  assert.deepEqual(snapshot.operations.map((op) => op.operationId), ['policy-one', 'policy-two']);
  assert.deepEqual(buildSharedReplica(groupId, [], snapshot), replica);
});
test('v2 occurrence identities bind group, chore and anchor while subjects remain independent of recommendation and rule revisions', () => {
  const id = v2OccurrenceId(groupId, 'floor', '2026-10-27');
  assert.equal(id, v2OccurrenceId(groupId, 'floor', '2026-10-27'));
  assert.equal(v2SubjectOccurrenceId(id, null), id);
  assert.notEqual(v2SubjectOccurrenceId(id, 'member-a'), v2SubjectOccurrenceId(id, 'member-b'));
  assert.notEqual(id, v2OccurrenceId('another-group', 'floor', '2026-10-27'));
  assert.notEqual(id, v2OccurrenceId(groupId, 'floor', '2026-10-28'));
  assert.throws(() => v2OccurrenceId(groupId, 'floor', '2026-02-30'));
});
test('v2 SQLite operations allocate clocks, original times, signatures and outbox atomically and survive snapshot compaction', async () => {
  const h = createDatabase(); const identity = await createDeviceIdentity(crypto); const author = { ...scope, deviceId: identity.deviceId };
  try {
    await initializeSharingLedger(h.database);
    const drafts = [policyDraft(), draft('claim-a', 'claim', { choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: 'floor.2026-10-27', userId: 'owner' })];
    let projections = 0;
    const created = await createLocalSharedOperations(h.database, author, drafts, async () => { projections++; }, (op) => signSharedOperation(op, identity).authorSignature);
    assert.deepEqual(created.map((op) => [op.schemaVersion, op.recordedAt, op.deviceSequence]), [[2, recordedAt, 1], [2, recordedAt, 2]]);
    assert.equal(projections, 1); assert.equal((await listSharingOutbox(h.database, groupId)).length, 2);
    const loaded = await loadSharedReplica(h.database, groupId);
    const restored = buildSharedReplica(groupId, [], compactSharedReplica(loaded));
    assert.deepEqual(restored.entities, loaded.entities); assert.deepEqual(restored.frontier, loaded.frontier);
    assert.ok(h.connection.prepare('SELECT author_signature FROM sharing_operations').all().every((row) => /^[a-f0-9]{128}$/.test(row.author_signature)));
    const retry = await createLocalSharedOperations(h.database, { ...author, recordedAt: undefined }, drafts, async () => { throw new Error('Duplicate should not project'); });
    assert.deepEqual(retry, created);
    await assert.rejects(createLocalSharedOperations(h.database, { ...author, recordedAt: '2026-10-27T11:00:00Z' }, drafts, async () => {}));
  } finally { h.connection.close(); }
});
test('v2 failed projection rolls back its operations and outbox without consuming the next device sequence', async () => {
  const h = createDatabase();
  try {
    await initializeSharingLedger(h.database);
    await h.database.execAsync('CREATE TABLE v2_derived_test (value TEXT)');
    await assert.rejects(createLocalSharedOperations(h.database, scope, [policyDraft()], async (db) => {
      await db.runAsync('INSERT INTO v2_derived_test VALUES (?)', 'not-committed'); throw new Error('projection failed');
    }), /projection failed/);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS count FROM v2_derived_test').get().count, 0);
    assert.equal((await listSharingOutbox(h.database, groupId)).length, 0);
    const [created] = await createLocalSharedOperations(h.database, scope, [policyDraft()], async () => {});
    assert.equal(created.deviceSequence, 1); assert.equal(created.logicalClock, 1);
  } finally { h.connection.close(); }
});
test('v1 projection refuses schema2 before writing derived state and leaves its original SQLite and outbox intact', async () => {
  const h = createDatabase(); const identity = await createDeviceIdentity(crypto);
  try {
    const bound = { userId: 'owner', groupId, householdId: 'local-household' };
    const roster = createSharedRoster(groupId, 'owner', identity);
    await initializeSharedProjection(h.database, bound); await initializeSharingLedger(h.database);
    const adapter = createSharedPlannerRepository(h.database, { ...bound, identity, roster: () => roster, makeId: () => 'unused', now: () => new Date(recordedAt) });
    await assert.rejects(createLocalSharedOperations(h.database, { ...scope, deviceId: identity.deviceId }, [policyDraft()], adapter.project), { code: 'sharing/scheduler-version-mismatch' });
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS count FROM sharing_operations').get().count, 0);
    assert.equal((await listSharingOutbox(h.database, groupId)).length, 0);
    assert.equal(h.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { h.connection.close(); }
});
