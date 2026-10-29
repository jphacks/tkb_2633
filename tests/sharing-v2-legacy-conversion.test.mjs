import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyMigrationFixture as fixture } from './helpers/sharing-v2-legacy-fixture.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { verifyLegacyMigrationSource, bindLegacyMigrationWitness, readVerifiedLegacyMigrationSource } from '../src/features/sharing/v2/legacy-migration-source.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { prepareLegacyMigrationPlan, validateLegacyMigrationPlan, legacyMigrationDrafts } from '../src/features/sharing/v2/legacy-migration-plan.ts';
import { createV2LegacyMigrationStager } from '../src/platform/storage/sharing-v2-legacy-migration.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { canonicalJson } from '../src/features/sharing/operations.ts';
import { loadSharedFacts, loadSharedReplica, listSharingOutbox, readSharingCheckpoint } from '../src/platform/storage/sharing-ledger.ts';
import { initializeSharedProjection } from '../src/platform/storage/sharing-projection.ts';
import { migrateLocalDatabase } from '../src/platform/storage/migrations.ts';
import { initializeV2EventStore, createV2EventRepository } from '../src/platform/storage/sharing-v2-events.ts';
const { ensureLocalHousehold } = await import('../src/platform/storage/repository.ts');
const now = () => new Date('2026-10-29T00:00:00Z');
const config = (preset = 'common') => ({ policy: chorePolicyFromPreset(preset), anchorDate: '2026-10-29', intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, active: true });
async function prepared(count = 1) {
  const h = await fixture(); let input = h.input;
  if (count > 1) {
    const operations = [h.operations[0], ...Array.from({ length: count }, (_, i) => h.op(`definition-${i}`, h.owner, 'owner', i + 2, i + 2,
      { [h.owner.deviceId]: i + 1 }, 'chore', `floor-${i}`, { name: `共有の家事 ${i}`, enabled: true, userIntervalDays: 7 }))];
    const encrypted = await h.make(operations, 'bulk-conversion-source');
    input = { ...h.input, encrypted, expectedSnapshotDigest: sharedDocumentDigest(encrypted.manifest), expectedThroughSequence: operations.length };
  }
  const checkpoint = await verifyLegacyMigrationSource(input); const bound = bindLegacyMigrationWitness(checkpoint, h.next, h.owner, 'roommates');
  const source = readVerifiedLegacyMigrationSource(bound.checkpoint);
  const choices = source.replica.entities.filter(entity => entity.entityType === 'chore').map(entity => ({ choreId: entity.entityId, kind: 'configure', configuration: config() }));
  const plan = prepareLegacyMigrationPlan(bound.checkpoint, { id: 'explicit-conversion', userId: 'owner', groupPolicy: createGroupPolicy('roommates'), choices, now: now() });
  const history = [...h.archive, h.next]; let active = true; let time = now();
  const options = { checkpoint: bound.checkpoint, plan, userId: 'owner', groupId: h.groupId, householdId: 'shared-v2', identity: h.owner,
    archive: () => history, assertAccess: () => { if (!active) throw new Error('account changed'); }, now: () => time };
  return { ...h, input, bound, choices, plan, history, options, stop() { active = false; }, resume() { active = true; }, time(date) { time = new Date(date); } };
}
function dump(h) {
  return h.connection.prepare("SELECT name,sql FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()
    .map(({ name, sql }) => [name, sql, h.connection.prepare(`SELECT * FROM "${name.replaceAll('"', '""')}" ORDER BY rowid`).all()]);
}

test('v2 legacy conversion requires one explicit choice for every current chore and authors no replacement history or personal data', async () => {
  const h = await prepared(); const sourceBefore = JSON.stringify(h.input.encrypted);
  const drafts = legacyMigrationDrafts(h.plan, h.bound.checkpoint);
  assert.deepEqual(drafts.map(draft => draft.entityType), ['groupPolicy', 'chorePolicy', 'chore', 'migration']);
  assert.equal(drafts.at(-1).operationId, 'explicit-conversion.finish');
  assert.ok(drafts.filter(draft => draft.entityType === 'chorePolicy' || draft.entityType === 'chore').every(draft => draft.entityId === 'floor'));
  assert.equal(h.plan.records[0].configuration.effectiveFrom, '2026-10-29');
  assert.equal(JSON.stringify(h.input.encrypted), sourceBefore); assert.equal(readVerifiedLegacyMigrationSource(h.bound.checkpoint).replica.operations.filter(op => op.entityType === 'completion').length, 3);
  assert.deepEqual(validateLegacyMigrationPlan(h.plan, h.bound.checkpoint, now()), h.plan);
});

test('v2 migration review refuses missing choices foreign assignees unknown fields disabled ambiguity and invented cadence', async () => {
  const h = await prepared(); const input = { id: h.plan.id, userId: 'owner', groupPolicy: createGroupPolicy('roommates'), choices: h.choices, now: now() };
  for (const choices of [[], [...h.choices, h.choices[0]], [{ ...h.choices[0], choreId: 'foreign' }],
    [{ ...h.choices[0], configuration: { ...config(), intervalDays: 0 } }], [{ ...h.choices[0], configuration: { ...config(), active: undefined } }],
    [{ ...h.choices[0], configuration: { ...config(), ruleVersion: 99 } }],
    [{ ...h.choices[0], configuration: { ...config(), policy: { completion: 'one', assignment: { mode: 'selected', memberIds: ['stranger'] } } } }]]) {
    assert.throws(() => prepareLegacyMigrationPlan(h.bound.checkpoint, { ...input, choices }));
  }
  assert.throws(() => prepareLegacyMigrationPlan(h.bound.checkpoint, { ...input, userId: 'member' }));
  assert.throws(() => prepareLegacyMigrationPlan(h.bound.checkpoint, { ...input, groupPolicy: createGroupPolicy('family') }));
});

test('v2 migration review pins source audience schema and local day while keeping explicit disabled chores disabled', async () => {
  const h = await prepared();
  const each = prepareLegacyMigrationPlan(h.bound.checkpoint, { id: 'each-person', userId: 'owner', groupPolicy: createGroupPolicy('roommates'),
    choices: [{ ...h.choices[0], configuration: config('eachMember') }], now: now() });
  assert.deepEqual(each.records[0].configuration.targetMemberIds, ['member', 'owner']);
  const disabled = prepareLegacyMigrationPlan(h.bound.checkpoint, { id: 'disabled', userId: 'owner', groupPolicy: createGroupPolicy('roommates'),
    choices: [{ choreId: 'floor', kind: 'keepDisabled' }], now: now() });
  assert.deepEqual(legacyMigrationDrafts(disabled, h.bound.checkpoint).map(draft => draft.entityType), ['groupPolicy', 'chore', 'migration']);
  assert.equal(legacyMigrationDrafts(disabled, h.bound.checkpoint)[1].payload.enabled, false);
  for (const change of [value => { value.groupId = 'foreign'; }, value => { value.records[0].configuration.ruleVersion = 2; },
    value => { value.records[0].configuration.targetMemberIds = ['owner']; }, value => { value.sourcePin.witnessDigest = '0'.repeat(64); }]) {
    const value = structuredClone(each); change(value); assert.throws(() => validateLegacyMigrationPlan(value, h.bound.checkpoint));
  }
  assert.throws(() => validateLegacyMigrationPlan(h.plan, h.bound.checkpoint, new Date('2026-10-30T00:00:00Z')), /日付/u);
});

test('v2 isolated legacy conversion stages signed settings and the exact original source without duplicate work or a fabricated receipt', async () => {
  const h = await prepared(); const target = createDatabase(); const before = canonicalJson(h.input.encrypted);
  try {
    const stager = createV2LegacyMigrationStager(target.database, h.options); const done = await stager.stage();
    assert.equal(done.phase, 'ready'); assert.equal(done.completedDrafts, 4); assert.equal((await listSharingOutbox(target.database, h.groupId)).length, 4);
    const facts = await loadSharedFacts(target.database, h.groupId); const originals = facts.filter(fact => fact.operation.schemaVersion === 1);
    assert.equal(originals.length, h.bound.snapshot.facts.length);
    for (const fact of h.bound.snapshot.facts) assert.deepEqual(originals.find(row => row.operation.operationId === fact.operation.operationId), fact);
    assert.equal(target.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_server_receipts').get().n, 0);
    const after = dump(target); await stager.stage(); assert.deepEqual(dump(target), after);
    assert.equal(canonicalJson(h.input.encrypted), before); assert.equal(target.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { target.connection.close(); }
});

test('v2 legacy staging commits at most one hundred operations at once and resumes next day from the last durable page', async () => {
  const h = await prepared(130); const target = createDatabase(); const pages = []; let fail = true;
  try {
    const first = createV2LegacyMigrationStager(target.database, { ...h.options, afterBatch: status => { pages.push(status.completedDrafts); if (fail) { fail = false; throw new Error('foreground interrupted'); } } });
    await assert.rejects(first.stage(), /foreground interrupted/u); assert.equal((await first.readStatus()).completedDrafts, 100);
    const initial = (await loadSharedFacts(target.database, h.groupId)).filter(fact => fact.operation.schemaVersion === 2);
    assert.equal(initial.length, 100); h.time('2026-10-30T00:00:00Z');
    const resumed = createV2LegacyMigrationStager(target.database, { ...h.options, afterBatch: status => { pages.push(status.completedDrafts); } });
    const done = await resumed.stage(); assert.equal(done.totalDrafts, 262); assert.equal(done.phase, 'ready'); assert.deepEqual(pages, [100, 200, 262]);
    const facts = await loadSharedFacts(target.database, h.groupId); const added = facts.filter(fact => fact.operation.schemaVersion === 2);
    assert.equal(added.length, 262); assert.equal(new Set(added.map(fact => fact.operation.operationId)).size, 262);
    for (const fact of initial) assert.deepEqual(added.find(row => row.operation.operationId === fact.operation.operationId), fact);
    assert.ok(added.some(fact => fact.operation.recordedAt === '2026-10-30T00:00:00.000Z'));
    assert.equal((await listSharingOutbox(target.database, h.groupId)).length, 100, 'the existing sender reads at most one hundred at a time');
    assert.equal(target.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n, 262);
    assert.throws(() => validateLegacyMigrationPlan(h.plan, h.bound.checkpoint, h.options.now()), /日付/u, 'a later initial cloud confirmation still needs a fresh review');
  } finally { target.connection.close(); }
});

test('v2 account change during private migration leaves the completed page resumable and never finishes in the other account', async () => {
  const h = await prepared(130); const target = createDatabase();
  try {
    const interrupted = createV2LegacyMigrationStager(target.database, { ...h.options, afterBatch: () => h.stop() });
    await assert.rejects(interrupted.stage(), /account changed/u);
    assert.equal((await listSharingOutbox(target.database, h.groupId)).length, 100); h.resume();
    assert.equal((await createV2LegacyMigrationStager(target.database, h.options).stage()).completedDrafts, 262);
  } finally { target.connection.close(); }
});

test('v2 migration source import and its private preparation row roll back together on a write failure', async () => {
  const h = await prepared(); const target = createDatabase(); const run = target.database.runAsync;
  try {
    target.database.runAsync = async (sql, ...args) => { if (sql.startsWith('INSERT INTO sharing_v2_migration_stage')) throw new Error('journal full'); return run(sql, ...args); };
    await assert.rejects(createV2LegacyMigrationStager(target.database, h.options).stage(), /journal full/u);
    assert.equal((await readSharingCheckpoint(target.database, h.groupId)).cursor, null); assert.equal((await loadSharedFacts(target.database, h.groupId)).length, 0);
    assert.equal(target.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_migration_stage'").get().n, 0);
    target.database.runAsync = run; assert.equal((await createV2LegacyMigrationStager(target.database, h.options).stage()).phase, 'ready');
  } finally { target.database.runAsync = run; target.connection.close(); }
});

test('v2 legacy conversion refuses personal existing v1 and nonempty unrelated v2 databases without replacing their rows', async () => {
  const h = await prepared();
  for (const kind of ['personal', 'v1', 'v2']) {
    const target = createDatabase();
    try {
      if (kind === 'personal') { await migrateLocalDatabase(target.database); await ensureLocalHousehold(target.database); }
      else if (kind === 'v1') await initializeSharedProjection(target.database, h.options);
      else {
        await initializeV2EventStore(target.database, h.options);
        const repo = createV2EventRepository(target.database, { ...h.options, anchor: h.history[0], assertWritable: h.options.assertAccess });
        await repo.commit([{ operationId: 'unrelated-v2', entityType: 'chore', entityId: 'unrelated', operationType: 'patch', payload: { name: '既存の設定', enabled: false } }]);
      }
      const before = dump(target); await assert.rejects(createV2LegacyMigrationStager(target.database, h.options).stage()); assert.deepEqual(dump(target), before);
    } finally { target.connection.close(); }
  }
});

test('v2 interrupted migration rejects a different reviewed plan and refuses a progress counter without the actual expected operations', async () => {
  const h = await prepared(130); const target = createDatabase();
  try {
    const first = createV2LegacyMigrationStager(target.database, { ...h.options, afterBatch: () => { throw new Error('pause'); } }); await assert.rejects(first.stage(), /pause/u);
    const changed = prepareLegacyMigrationPlan(h.bound.checkpoint, { id: h.plan.id, userId: 'owner', groupPolicy: h.plan.groupPolicy,
      choices: h.choices.map((choice, index) => index ? choice : { ...choice, configuration: { ...choice.configuration, intervalDays: 14 } }), now: now() });
    const before = dump(target); await assert.rejects(createV2LegacyMigrationStager(target.database, { ...h.options, plan: changed }).stage(), /異なります/u); assert.deepEqual(dump(target), before);
    target.connection.prepare('UPDATE sharing_v2_migration_stage SET completed_drafts=total_drafts').run();
    await assert.rejects(createV2LegacyMigrationStager(target.database, h.options).stage(), /検査を完了/u);
  } finally { target.connection.close(); }
});

test('v2 concurrent migration preparations converge to one source journal and one set of signed operations', async () => {
  const h = await prepared(130); const target = createDatabase();
  try {
    const a = createV2LegacyMigrationStager(target.database, h.options); const b = createV2LegacyMigrationStager(target.database, h.options);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2 ? a.stage() : b.stage()));
    assert.ok(results.every(status => status.phase === 'ready' && status.completedDrafts === 262));
    assert.equal((await listSharingOutbox(target.database, h.groupId)).length, 100);
    assert.equal(target.connection.prepare('SELECT COUNT(*) AS n FROM sharing_outbox').get().n, 262);
    const replica = await loadSharedReplica(target.database, h.groupId); assert.equal(replica.operations.filter(op => op.schemaVersion === 2).length, 262);
    assert.equal(target.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_migration_stage').get().n, 1);
  } finally { target.connection.close(); }
});

test('v2 simultaneous store initialization captures its original scope coalesces setup and rejects a competing account', async () => {
  const target = createDatabase(); const all = target.database.getAllAsync;
  let begin; let release; const started = new Promise(resolve => { begin = resolve; }); const gate = new Promise(resolve => { release = resolve; }); let paused = false;
  try {
    target.database.getAllAsync = async (sql, ...args) => { if (!paused && sql.includes('SELECT name FROM sqlite_master')) { paused = true; begin(); await gate; } return all(sql, ...args); };
    const scope = { userId: 'owner', groupId: 'isolated', householdId: 'shared-v2' };
    const first = initializeV2EventStore(target.database, scope); await started; scope.userId = 'different';
    const same = Array.from({ length: 100 }, () => initializeV2EventStore(target.database, { ...scope, userId: 'owner' }));
    const different = assert.rejects(initializeV2EventStore(target.database, scope), { code: 'sharing/access-denied' });
    release(); await first; await Promise.all(same); await different;
    assert.equal(target.connection.prepare('SELECT user_id FROM sharing_v2_binding').get().user_id, 'owner');
    assert.equal(target.writes.filter(row => row.sql.includes('INSERT OR IGNORE INTO sharing_v2_binding')).length, 1);
  } finally { release?.(); target.database.getAllAsync = all; target.connection.close(); }
});

test('v2 a failed initialization releases its pending state and retries without leaving a foreign binding', async () => {
  const target = createDatabase(); const run = target.database.runAsync; let fail = true;
  const scope = { userId: 'owner', groupId: 'isolated', householdId: 'shared-v2' };
  try {
    target.database.runAsync = async (sql, ...args) => { if (fail && sql.includes('INSERT OR IGNORE INTO sharing_v2_binding')) { fail = false; throw new Error('interrupted setup'); } return run(sql, ...args); };
    await assert.rejects(initializeV2EventStore(target.database, scope), /interrupted setup/u);
    await initializeV2EventStore(target.database, scope);
    assert.equal(target.connection.prepare('SELECT user_id FROM sharing_v2_binding').get().user_id, 'owner');
    assert.equal(target.connection.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  } finally { target.database.runAsync = run; target.connection.close(); }
});
