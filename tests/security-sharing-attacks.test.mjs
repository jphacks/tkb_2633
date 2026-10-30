import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity, decryptSharedOperation, encryptSharedOperation, signSharedDocument,
  sealSharedSnapshotChunk, openSharedSnapshotChunk, wrapGroupKey, unwrapGroupKey } from '../src/features/sharing/crypto.ts';
import { fixture, groupId } from './helpers/sharing-v2-plan-fixture.mjs';
import { v2DatePermissionId } from '../src/features/sharing/v2/occurrence-id.ts';
import { applianceManufacturerIdentity, isOfficialApplianceUrl } from '../src/features/appliance-care/official-url.ts';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import { sharedWorkspaceProtocol } from '../src/features/sharing/workspace-protocol.ts';

// Deliberately keep the attacker's valid signing key. These cases must reach the
// AEAD boundary, rather than passing only because a stale outer signature fails.
function resign(envelope, patch, identity) {
  const { signature: _signature, ...unsigned } = { ...envelope, ...patch };
  return { ...unsigned, signature: signSharedDocument(unsigned, identity) };
}
function flip(hex, byte) {
  const position = (byte % (hex.length / 2)) * 2;
  const mask = 1 << (Math.floor(byte / (hex.length / 2)) % 8);
  return hex.slice(0, position) + (parseInt(hex.slice(position, position + 2), 16) ^ mask).toString(16).padStart(2, '0') + hex.slice(position + 2);
}
function operation(identity) {
  return { schemaVersion: 1, operationId: 'attack-operation', groupId: 'attack-group', authorUserId: 'owner',
    authorDeviceId: identity.deviceId, deviceSequence: 1, logicalClock: 1, context: {}, keyVersion: 1,
    entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '検査用の架空の家事', enabled: true } };
}

test('security attack: inherited manufacturer names fail closed in the mobile official-link validator without crashing the screen', () => {
  for (const name of new Set([...Object.getOwnPropertyNames(Object.prototype), 'constructor', '__proto__', ' Constructor ', 'ＣＯＮＳＴＲＵＣＴＯＲ'])) {
    assert.equal(applianceManufacturerIdentity(name), null, name);
    assert.equal(isOfficialApplianceUrl('https://dyson.co.jp/product', name), false, name);
  }
  assert.equal(applianceManufacturerIdentity(' ダイソン '), 'dyson.co.jp');
  assert.equal(isOfficialApplianceUrl('https://www.dyson.co.jp/product', 'Dyson'), true);
});

test('security compatibility: the hardened v2 protocol refuses an older draft without mutating its signed data and leaves v1 usable', async () => {
  const identity = await createDeviceIdentity(crypto);
  const legacy = createSharedRoster('legacy-audit', 'owner', identity);
  const latest = createSharedRoster('v2-audit', 'owner', identity, { schemaVersion: 2 });
  assert.equal(sharedWorkspaceProtocol(legacy), 1); assert.equal(sharedWorkspaceProtocol(latest), 2);
  const body = { ...latest.body, schedulerVersion: 'liflow-shared-2-draft-36' };
  const old = { body, signer: latest.signer, signature: signSharedDocument(body, identity) };
  const before = JSON.stringify(old);
  assert.throws(() => sharedWorkspaceProtocol(old), { code: 'sharing/scheduler-version-mismatch' });
  assert.equal(JSON.stringify(old), before);
});

test('security attack: 320 correctly re-signed ciphertext, salt and nonce mutations fail AEAD without returning plaintext', async () => {
  const identity = await createDeviceIdentity(crypto); const key = await crypto.randomBytes(32);
  const envelope = await encryptSharedOperation(crypto, operation(identity), key, identity);
  let decryptions = 0;
  const measured = { ...crypto, decrypt: async (...args) => { decryptions++; return crypto.decrypt(...args); } };
  for (const [field, count] of [['encryptedPayload', 256], ['nonce', 32], ['salt', 32]]) {
    for (let index = 0; index < count; index++) {
      await assert.rejects(decryptSharedOperation(measured, resign(envelope, { [field]: flip(envelope[field], index) }, identity), key, identity, 'attack-group', 1));
    }
  }
  assert.equal(decryptions, 320, 'each valid outer signature reached authenticated decryption');
  assert.deepEqual(await decryptSharedOperation(crypto, envelope, key, identity, 'attack-group', 1), operation(identity));
});

test('security attack: correctly signed snapshot and recipient-key mutations cannot bypass their independent AEAD or context bindings', async () => {
  const owner = await createDeviceIdentity(crypto); const recipient = await createDeviceIdentity(crypto);
  const key = await crypto.randomBytes(32); const context = { groupId: 'attack-group', snapshotId: 'snapshot-test', chunkIndex: 0, keyVersion: 1 };
  const plaintext = new TextEncoder().encode('架空の復旧用スナップショット');
  const snapshot = await sealSharedSnapshotChunk(crypto, plaintext, context, key, owner);
  const wrapped = await wrapGroupKey(crypto, context.groupId, 1, key, owner, recipient, 'recipient');
  for (let index = 0; index < 64; index++) {
    await assert.rejects(openSharedSnapshotChunk(crypto, resign(snapshot, { encryptedPayload: flip(snapshot.encryptedPayload, index) }, owner), context, key, owner));
    await assert.rejects(unwrapGroupKey(crypto, resign(wrapped, { encryptedKey: flip(wrapped.encryptedKey, index) }, owner), recipient, 'recipient', owner, context.groupId, 1));
  }
  for (const change of [{ groupId: 'other-group' }, { snapshotId: 'other-snapshot' }, { chunkIndex: 1 }, { keyVersion: 2 }]) {
    await assert.rejects(openSharedSnapshotChunk(crypto, resign(snapshot, change, owner), context, key, owner));
  }
  for (const change of [{ recipientUserId: 'other-user' }, { recipientDeviceId: owner.deviceId }, { groupId: 'other-group' }, { keyVersion: 2 }]) {
    await assert.rejects(unwrapGroupKey(crypto, resign(wrapped, change, owner), recipient, 'recipient', owner, context.groupId, 1));
  }
  assert.deepEqual(await openSharedSnapshotChunk(crypto, snapshot, context, key, owner), plaintext);
  assert.deepEqual(await unwrapGroupKey(crypto, wrapped, recipient, 'recipient', owner, context.groupId, 1), key);
});

test('security attack: signed member updates cannot change administrator fields across group types and chore presets', async () => {
  const forbidden = { enabled: false, archived: true, recommendedCycleDays: 9, userIntervalDays: 9,
    manufacturerRecommendedIntervalDays: 9, requiresCycleSelection: true,
    frequencyDaysByMode: { frequent: 3, balanced: 7, relaxed: 14 }, windowRadiusDays: 4, maxShiftDays: 4,
    load: 'heavy', holidayPriority: true, everyday: true, estimatedMinutes: 99, laundryDryingPreference: 'outdoors' };
  for (const kind of ['family', 'roommates']) for (const preset of ['common', 'eachMember', 'assigned']) {
    const f = await fixture({ kind, preset, members: preset === 'assigned' ? ['a'] : [] });
    const attacks = [];
    for (const actor of ['a', 'b']) for (const [field, value] of Object.entries(forbidden)) {
      attacks.push(f.make('chore', { [field]: value }, { actor, entityId: 'floor' }));
    }
    const allowed = f.make('chore', { name: '全員が編集できる名前', instructions: ['手順を確認する'] }, { actor: 'a', entityId: 'floor' });
    const { assessment } = f.state();
    assert.deepEqual(new Set(assessment.rejected.map(row => row.operationId)), new Set(attacks.map(row => row.operationId)), `${kind}/${preset}`);
    assert.ok(assessment.rejected.every(row => row.kind === 'unauthorized'));
    assert.equal(assessment.view.byId(allowed.operationId)?.payload.name, '全員が編集できる名前');
    assert.deepEqual(f.state([...f.facts].reverse()).assessment.rejected.map(row => row.operationId), assessment.rejected.map(row => row.operationId));
  }
});

test('security attack: a signed forged grant and its descendants cannot escalate privilege while independent members continue editing', async () => {
  const f = await fixture({ preset: 'assigned', members: ['owner'] }); const seed = f.facts.map(fact => fact.operation);
  const grant = f.make('datePermission', { choreId: 'floor', userId: 'a', enabled: true,
    rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } },
  { actor: 'a', entityId: v2DatePermissionId(groupId, 'floor', 'a') });
  const elevated = f.designation({ precision: 'date', date: '2026-10-28' }, { actor: 'a' });
  const independent = f.make('chore', { instructions: ['独立した正規の変更'] }, { actor: 'b', entityId: 'floor', observed: seed });
  const expected = [grant.operationId, elevated.operationId];
  for (const order of [f.facts, [...f.facts].reverse(), [...f.facts.slice(0, 4), f.facts.at(-1), f.facts[5], f.facts[4]]]) {
    const { assessment } = f.state(order);
    assert.deepEqual(assessment.rejected.map(row => row.operationId), expected);
    assert.ok(assessment.view.byId(independent.operationId));
    for (const id of expected) assert.equal(assessment.view.byId(id), undefined);
  }
});

test('security attack: concurrent completion, replay and targeted undo converge without deleting another members work', async () => {
  const f = await fixture(); const seed = f.facts.map(fact => fact.operation);
  const a = f.complete({ actor: 'a' });
  const b = f.make('completion', { ...a.payload, completedByMemberId: 'b' }, { actor: 'b', entityId: a.entityId, operationType: 'complete', observed: seed });
  const unauthorisedUndo = f.make('completion', { targetOperationId: a.operationId }, { actor: 'b', entityId: a.entityId, operationType: 'undo' });
  const undo = f.make('completion', { targetOperationId: a.operationId }, { actor: 'a', entityId: a.entityId, operationType: 'undo' });
  const baseline = f.plan();
  for (const ordered of [[...f.facts].reverse(), [...f.facts, ...f.facts], [...f.facts.slice(2), ...f.facts.slice(0, 2)]]) {
    const { assessment } = f.state(ordered);
    assert.deepEqual(assessment.rejected.map(row => row.operationId), [unauthorisedUndo.operationId]);
    assert.ok(assessment.view.byId(undo.operationId)); assert.ok(assessment.view.byId(b.operationId));
    assert.deepEqual(f.plan({}, ordered), baseline);
  }
  assert.ok(baseline.occurrences.find(row => row.id === f.occurrence()).subjects.some(row => row.completed));
});
