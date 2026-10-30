import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { canonicalJson, validateSharedOperation } from '../src/features/sharing/operations.ts';
import { buildSharedReplica } from '../src/features/sharing/replica.ts';

export function operation(overrides = {}) {
  return { schemaVersion: 1, operationId: 'op-a1', groupId: 'group-test', authorUserId: 'user-a',
    authorDeviceId: 'device-a', deviceSequence: 1, logicalClock: 1, context: {}, keyVersion: 1,
    entityType: 'chore', entityId: 'floor', operationType: 'patch', payload: { name: '床掃除', enabled: true }, ...overrides };
}

function permutations(input) {
  if (input.length < 2) return [input];
  return input.flatMap((item, i) => permutations(input.filter((_, n) => n !== i)).map((rest) => [item, ...rest]));
}

test('shared replicas converge for every arrival order, duplicate delivery and concurrent edits of different fields', () => {
  const initial = operation();
  const frequency = operation({ operationId: 'op-a2', deviceSequence: 2, logicalClock: 2,
    context: { 'device-a': 1 }, payload: { recommendedCycleDays: 7 } });
  const name = operation({ operationId: 'op-b1', authorUserId: 'user-b', authorDeviceId: 'device-b',
    logicalClock: 2, context: { 'device-a': 1 }, payload: { name: 'フローリング' } });
  const expected = buildSharedReplica('group-test', [initial, frequency, name]);
  for (const order of permutations([initial, frequency, name])) {
    assert.deepEqual(buildSharedReplica('group-test', [...order, ...order]), expected);
  }
  assert.deepEqual(expected.entities[0].fields, { enabled: true, name: 'フローリング', recommendedCycleDays: 7 });
  assert.deepEqual(expected.entities[0].conflicts, {});
});

test('shared conflicting settings are retained without choosing a last writer, and an explicit observed resolution converges', () => {
  const a = operation({ payload: { recommendedCycleDays: 7 } });
  const b = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', authorUserId: 'user-b', payload: { recommendedCycleDays: 14 } });
  const replica = buildSharedReplica('group-test', [b, a]);
  assert.equal(replica.entities[0].fields.recommendedCycleDays, undefined);
  assert.equal(replica.entities[0].conflicts.recommendedCycleDays.length, 2);
  const resolved = operation({ operationId: 'op-a2', deviceSequence: 2, logicalClock: 2,
    context: { 'device-a': 1, 'device-b': 1 }, payload: { recommendedCycleDays: 10 } });
  for (const order of permutations([a, b, resolved])) {
    const entity = buildSharedReplica('group-test', order).entities[0];
    assert.deepEqual(entity.fields, { recommendedCycleDays: 10 }); assert.deepEqual(entity.conflicts, {});
  }
});

test('same-value concurrent settings do not require a meaningless user conflict decision', () => {
  const a = operation();
  const b = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', authorUserId: 'user-b' });
  const entity = buildSharedReplica('group-test', [a, b]).entities[0];
  assert.deepEqual(entity.conflicts, {}); assert.equal(entity.revisions.name.length, 2);
});

test('a deletion concurrent with editing remains a visible conflict rather than silently resurrecting a chore', () => {
  const a = operation();
  const deletion = operation({ operationId: 'op-a2', deviceSequence: 2, logicalClock: 2,
    context: { 'device-a': 1 }, operationType: 'delete', payload: {} });
  const edit = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', authorUserId: 'user-b',
    logicalClock: 2, context: { 'device-a': 1 }, payload: { name: '新しい名前' } });
  for (const order of permutations([a, deletion, edit])) {
    const entity = buildSharedReplica('group-test', order).entities[0];
    assert.equal(entity.deleted, true); assert.equal(entity.conflicts.$alive.length, 2);
  }
});

test('simultaneous completion is displayed once and undo targets only the observed completion even when delivered first', () => {
  const a = operation({ entityType: 'completion', entityId: 'floor:2026-10-27', operationType: 'complete',
    payload: { choreId: 'floor', completedAt: '2026-10-27T01:00:00.000Z', outcome: 'completed' } });
  const b = { ...a, operationId: 'op-b1', authorDeviceId: 'device-b', authorUserId: 'user-b' };
  const undo = operation({ operationId: 'op-a2', deviceSequence: 2, logicalClock: 2, context: { 'device-a': 1 },
    entityType: 'completion', entityId: a.entityId, operationType: 'undo', payload: { targetOperationId: a.operationId } });
  assert.equal(buildSharedReplica('group-test', [a, b]).completions.length, 1);
  for (const order of permutations([a, b, undo])) {
    const replica = buildSharedReplica('group-test', order);
    assert.equal(replica.completions.length, 1); assert.deepEqual(replica.completions[0].activeOperationIds, ['op-b1']);
  }
  assert.equal(buildSharedReplica('group-test', [undo, a]).completions.length, 0);
  assert.throws(() => buildSharedReplica('group-test', [a, { ...undo, context: { 'device-a': 1 }, entityId: 'wrong-occurrence' }]), /target completion/);
});

test('a completed outcome takes precedence over an independent incomplete report of the same occurrence without erasing either fact', () => {
  const a = operation({ entityType: 'completion', operationType: 'complete',
    payload: { choreId: 'floor', completedAt: '2026-10-27T01:00:00Z', outcome: 'incomplete' } });
  const b = { ...a, operationId: 'zz-b1', authorDeviceId: 'device-b', authorUserId: 'user-b', payload: { ...a.payload, outcome: 'completed' } };
  const replica = buildSharedReplica('group-test', [a, b]);
  assert.equal(replica.completions[0].payload.outcome, 'completed'); assert.equal(replica.completions[0].activeOperationIds.length, 2);
});

test('a valid undo cannot hide an additional malformed undo of the same completion', () => {
  const completion = operation({ entityType: 'completion', entityId: 'floor:2026-10-27', operationType: 'complete',
    payload: { choreId: 'floor', completedAt: '2026-10-27T01:00:00Z', outcome: 'completed' } });
  const valid = operation({ operationId: 'op-a2', deviceSequence: 2, logicalClock: 2, context: { 'device-a': 1 },
    entityType: 'completion', entityId: completion.entityId, operationType: 'undo', payload: { targetOperationId: completion.operationId } });
  const invalid = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', logicalClock: 2, context: { 'device-a': 1 },
    entityType: 'completion', entityId: 'different-occurrence', operationType: 'undo', payload: { targetOperationId: completion.operationId } });
  assert.throws(() => buildSharedReplica('group-test', [completion, valid, invalid]), /target completion/);
  assert.throws(() => buildSharedReplica('group-test', [operation(), { ...valid, payload: { targetOperationId: 'missing' } }]), /target completion/);
});

test('missing causal dots are not acknowledged by a larger received sequence or a remote context', () => {
  const future = operation({ operationId: 'op-a3', deviceSequence: 3, logicalClock: 3, context: { 'device-a': 2 } });
  const b = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', authorUserId: 'user-b', logicalClock: 100,
    context: { 'device-a': 99 } });
  const replica = buildSharedReplica('group-test', [future, b]);
  assert.deepEqual(replica.frontier, { 'device-a': 0, 'device-b': 0 });
  assert.equal(replica.entities.length, 0); assert.equal(replica.pendingOperationIds.length, 2);
});

test('a descendant cannot make a received operation with missing causal context appear applied', () => {
  const missingParent = operation({ context: { 'device-z': 1 }, logicalClock: 2 });
  const descendant = operation({ operationId: 'op-b1', authorDeviceId: 'device-b',
    context: { 'device-a': 1, 'device-z': 1 }, logicalClock: 3 });
  const partial = buildSharedReplica('group-test', [descendant, missingParent]);
  assert.equal(partial.entities.length, 0); assert.equal(partial.pendingOperationIds.length, 2);
  const parent = operation({ operationId: 'op-z1', authorDeviceId: 'device-z' });
  const complete = buildSharedReplica('group-test', [descendant, parent, missingParent]);
  assert.equal(complete.pendingOperationIds.length, 0); assert.equal(complete.entities[0].fields.name, '床掃除');
});

test('received vectors must preserve transitive causal information instead of inventing a new conflict', () => {
  const a = operation();
  const b = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', logicalClock: 2, context: { 'device-a': 1 } });
  const c = operation({ operationId: 'op-c1', authorDeviceId: 'device-c', logicalClock: 3, context: { 'device-b': 1 } });
  assert.throws(() => buildSharedReplica('group-test', [a, b, c]), /not transitive/);
  assert.equal(buildSharedReplica('group-test', [a, b, { ...c, context: { 'device-a': 1, 'device-b': 1 } }]).pendingOperationIds.length, 0);
});

test('operation identity collisions, reused device sequences, causal cycles and cross-group delivery are rejected', () => {
  const a = operation();
  assert.throws(() => buildSharedReplica('group-test', [a, { ...a, payload: { name: '別の内容' } }]), /ID reused/);
  assert.throws(() => buildSharedReplica('group-test', [a, { ...a, operationId: 'other' }]), /sequence reused/);
  assert.throws(() => buildSharedReplica('group-test', [{ ...a, groupId: 'foreign' }]), /group mismatch/);
  const b = operation({ operationId: 'op-b1', authorDeviceId: 'device-b', logicalClock: 2, context: { 'device-a': 1 } });
  assert.throws(() => buildSharedReplica('group-test', [{ ...a, logicalClock: 2, context: { 'device-b': 1 } }, b]), /Causal cycle/);
});

test('shared payload validation rejects local-only data, unreviewed appliance analysis and unsupported schemas', () => {
  for (const value of [operation({ schemaVersion: 2 }), operation({ entityType: 'googleTasks' }),
    operation({ payload: { googleTaskId: 'private' } }), operation({ payload: { weatherLocation: {} } }),
    operation({ entityType: 'settings', payload: { notificationHour: 9 } }),
    operation({ entityType: 'appliance', payload: { analysis: { tasks: [] } } }),
    operation({ payload: { name: { apiKey: 'private' } } }),
    operation({ deviceSequence: 2 }), operation({ logicalClock: Infinity })]) {
    assert.throws(() => validateSharedOperation(value));
  }
  assert.throws(() => canonicalJson(JSON.parse('{"__proto__":{"enabled":true}}')), /unsafe/);
  for (const key of ['client_secret', 'API_KEY', 'signingSecretKey', 'agreement-secret-key', 'Authorization', 'groupKey']) {
    assert.throws(() => canonicalJson({ policyData: { [key]: 'synthetic-private-value' } }), /Private/);
  }
  assert.throws(() => canonicalJson({ x: undefined }));
  assert.throws(() => validateSharedOperation(operation({ payload: { instructions: Array(100).fill('x'.repeat(2000)) } })), /too large/);
  const reviewed = validateSharedOperation(operation({ entityType: 'appliance', payload: { reviewed: true,
    analysis: { manufacturer: 'Test', model: 'T1', tasks: [], analyzedAt: '2026-10-27T00:00:00Z', requiresUserReview: true } } }));
  assert.equal(reviewed.payload.reviewed, true);
});

test('invalid shared settings cannot cross the replica boundary even if they are otherwise valid JSON', () => {
  for (const [entityType, payload] of [['chore', { name: {} }], ['chore', { enabled: 'false' }],
    ['chore', { recommendedCycleDays: 0 }], ['chore', { load: 'huge' }], ['chore', { windowRadiusDays: 15 }],
    ['chore', { frequencyDaysByMode: { frequent: 1, balanced: 7, relaxed: 0 } }],
    ['settings', { restDays: [1, 1] }], ['settings', { restDays: [0] }], ['settings', { timeZone: 'Mars/Olympus' }],
    ['waste', { monthlyDay: 32 }], ['waste', { anchorDate: '2026-02-30' }], ['member', { displayName: '' }],
    ['assignment', { memberIds: ['member', 'member'] }]]) {
    assert.throws(() => validateSharedOperation(operation({ entityType, payload })), /Invalid shared/);
  }
});

test('shared operation validation detaches mutable input before an asynchronous write', () => {
  const input = operation(); const valid = validateSharedOperation(input); input.payload.name = 'changed';
  assert.equal(valid.payload.name, '床掃除');
});

test('a large completion history retains exact results without quadratic all-pairs causal validation', () => {
  const history = Array.from({ length: 12_000 }, (_, i) => operation({ operationId: `completion-${i}`,
    deviceSequence: i + 1, logicalClock: i + 1, context: i ? { 'device-a': i } : {},
    entityType: 'completion', entityId: `floor:${i}`, operationType: 'complete',
    payload: { choreId: 'floor', completedAt: '2026-10-27T01:00:00Z', outcome: 'completed' } }));
  const replica = buildSharedReplica('group-test', history.reverse());
  assert.equal(replica.completions.length, 12_000); assert.equal(replica.frontier['device-a'], 12_000);
});

test('twelve thousand sequential edits of the same setting retain the final value without quadratic field comparisons', () => {
  const history = Array.from({ length: 12_000 }, (_, i) => operation({ operationId: `edit-${i}`,
    deviceSequence: i + 1, logicalClock: i + 1, context: i ? { 'device-a': i } : {}, payload: { name: `家事${i}` } }));
  const replica = buildSharedReplica('group-test', history.reverse());
  assert.equal(replica.entities[0].fields.name, '家事11999'); assert.deepEqual(replica.entities[0].conflicts, {});
});
