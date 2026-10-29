import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, groupId, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createHouseholdChoreDefinitions } from '../src/domain/chores/catalog.ts';
import { createV2PersonalCopyStore } from '../src/platform/storage/sharing-v2-personal-copy.ts';
import { createV2PersonalCopyRuntime } from '../src/features/sharing/v2/personal-copy-runtime.ts';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as storeModule from '../src/platform/storage/sharing-v2-personal-copy.ts';
import * as runtimeModule from '../src/features/sharing/v2/personal-copy-runtime.ts';
import { readFileSync } from 'node:fs';
import { createDatabase } from './helpers/sqlite.mjs';
import { createSharedRoster } from '../src/features/sharing/roster.ts';
import * as eventModule from '../src/platform/storage/sharing-v2-events.ts';
import { drainSharingLedger } from '../src/platform/storage/sharing-ledger.ts';
import { V2_SCHEDULER_VERSION } from '../src/features/sharing/v2/payload-schema.ts';
import { v2GroupBootstrap } from '../src/features/sharing/v2/bootstrap.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { sharedDocumentDigest } from '../src/features/sharing/crypto.ts';
import { buildV2CommonPlan } from '../src/features/sharing/v2/common-plan.ts';

async function setup() {
  const family = await fixture(); const d = await family.device(); await d.repository.commit(seeds());
  let allowed = true; let number = 0; const reads = [];
  const source = { scope: 'personal', ownerUserId: 'owner', householdId: 'local-household', frequencyMode: 'balanced', chores: createHouseholdChoreDefinitions('local-household') };
  const assertAccess = () => { if (!allowed) throw new Error('workspace changed'); };
  const options = { repository: d.repository, userId: 'owner', groupId, assertAccess, now, makeId: () => `runtime-copy-${++number}` };
  const store = createV2PersonalCopyStore(options);
  const input = { ...options, store, async readSource(ids) { reads.push(ids ? [...ids] : null); return structuredClone({ ...source, chores: source.chores.filter(chore => !ids || ids.includes(chore.id)) }); } };
  return { family, d, source, store, input, reads, runtime: createV2PersonalCopyRuntime(input), stop() { allowed = false; }, close() { d.connection.close(); } };
}
test('personal copy runtime rejects a foreign store before any private read', () => {
  let accessed = 0;
  assert.throws(() => createV2PersonalCopyRuntime({ userId: 'owner', groupId, store: { scope: { userId: 'other', groupId } },
    assertAccess() { accessed++; }, readSource() { accessed++; } }), /本人/u);
  assert.equal(accessed, 0);
});
test('personal copy chooser exposes only owned names and flags, and opening a saved review never rereads personal history', async () => {
  const h = await setup();
  try {
    const initial = await h.runtime.load(); assert.equal(initial.control.review, null);
    assert.deepEqual(Object.keys(initial.choices[0]).sort(), ['enabled', 'id', 'name', 'requiresCycleSelection']);
    assert.equal((await h.d.repository.readState()).replica.operations.length, 4);
    const saved = await h.runtime.prepare(0, [initial.choices[0].id], 'eachMember');
    assert.deepEqual(h.reads, [null, [initial.choices[0].id]]); assert.equal(saved.status, 'review');
    const reopened = createV2PersonalCopyRuntime({ ...h.input, readSource() { throw new Error('saved review must not read private source'); } });
    assert.deepEqual((await reopened.load()).control, saved);
    const committed = await h.runtime.confirm(saved.review); assert.equal(committed.status, 'committed');
    assert.deepEqual((await reopened.confirm(saved.review)).review, committed.review);
    assert.equal((await h.d.repository.readState()).replica.operations.length, 6);
  } finally { h.close(); }
});
test('personal copy captures the selected IDs before await and prevents duplicate pending actions', async () => {
  const h = await setup(); let release;
  try {
    const waiting = new Promise(resolve => { release = resolve; });
    const original = h.input.readSource;
    const runtime = createV2PersonalCopyRuntime({ ...h.input, async readSource(ids) { await waiting; return original(ids); } });
    const ids = [h.source.chores[0].id]; const expected = ids[0]; const preparing = runtime.prepare(0, ids, 'common'); ids[0] = 'changed-after-tap';
    await assert.rejects(runtime.prepare(0, [expected], 'common'), /終わるまで/u);
    release(); const saved = await preparing; assert.equal(saved.review.records[0].personalChoreId, expected);
    assert.equal(saved.revision, 1);
  } finally { release?.(); h.close(); }
});
test('personal copy source edits and revoked screen access cannot publish a reviewed draft', async () => {
  const h = await setup();
  try {
    const saved = await h.runtime.prepare(0, [h.source.chores[0].id], 'common');
    h.source.chores[0].name = '確認後の変更'; await assert.rejects(h.runtime.confirm(saved.review), /個人設定/u);
    assert.equal((await h.store.read()).status, 'review'); assert.equal((await h.d.repository.readState()).replica.operations.length, 4);
    h.stop(); await assert.rejects(h.runtime.confirm(saved.review), /workspace changed/u);
    assert.equal((await h.d.repository.readState()).replica.operations.length, 4);
  } finally { h.close(); }
});
test('personal copy rejects malformed or foreign personal chooser rows without changing the shared ledger', async () => {
  const h = await setup();
  try {
    for (const source of [{ ...h.source, ownerUserId: 'other' }, { ...h.source, scope: 'shared' },
      { ...h.source, chores: [{ ...h.source.chores[0], householdId: 'foreign' }] }]) {
      const runtime = createV2PersonalCopyRuntime({ ...h.input, readSource: async () => source }); await assert.rejects(runtime.load(), /本人/u);
    }
    assert.equal((await h.d.repository.readState()).replica.operations.length, 4);
  } finally { h.close(); }
});
test('Native personal copy reads only the validated personal database, filters selection and closes every connection', async () => {
  const h = await setup(); const calls = []; let shared = false; let revoke = false;
  try {
    const module = loadNativeModule('src/platform/sharing/v2-personal-copy.ts', {
      'expo-sqlite': { openDatabaseAsync: async (name, options) => { calls.push(['open', name, options]); return { closeAsync: async () => { calls.push('close'); } }; } },
      'expo-crypto': { randomUUID: h.input.makeId }, '../storage/sharing-v2-personal-copy': storeModule,
      '../../features/sharing/v2/personal-copy-runtime': runtimeModule,
      '../storage/repository': { readPersonalPlannerOverlaySnapshot: async () => { calls.push('read'); if (revoke) h.stop(); return { snapshot: {
        sharing: shared ? {} : undefined, household: { id: 'local-household' }, settings: { frequencyMode: 'balanced' }, chores: h.source.chores } }; } },
    });
    const runtime = module.createNativeV2PersonalCopy(h.input); const initial = await runtime.load(); assert.ok(initial.choices.length > 1);
    assert.deepEqual(calls, [['open', 'housework.db', { useNewConnection: true }], 'read', 'close']);
    const saved = await runtime.prepare(0, [initial.choices[0].id], 'common'); assert.equal(saved.review.records.length, 1);
    await runtime.clear(saved.revision); shared = true;
    await assert.rejects(runtime.load(), /本人/u); assert.equal(calls.at(-1), 'close');
    shared = false; revoke = true; await assert.rejects(runtime.load(), /workspace changed/u); assert.equal(calls.at(-1), 'close');
  } finally { h.close(); }
});
test('Native personal copy QA rejects release before identity database or personal access', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    const source = readFileSync(new URL('../src/platform/sharing/v2-personal-copy-preview.ts', import.meta.url), 'utf8');
    const mocks = Object.fromEntries([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => [match[1], {}]));
    const module = loadNativeModule('src/platform/sharing/v2-personal-copy-preview.ts', mocks);
    await assert.rejects(module.createV2PersonalCopyPreview(), /開発ビルド専用/u);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
test('Native copy QA uses the signed SQLite path for review commit idempotence and restart without a cloud account', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = true; const family = await fixture(); const h = createDatabase(); let number = 0;
  try {
    const module = loadNativeModule('src/platform/sharing/v2-personal-copy-preview.ts', {
      'expo-crypto': { randomUUID: () => `native-qa-copy-${++number}` }, './secure-store': { loadOrCreateSharingDeviceIdentity: async () => family.owner },
      './database-location': { openSharingV2Database: async () => h.database }, '../../features/sharing/roster': { createSharedRoster },
      '../storage/sharing-v2-events': eventModule, '../storage/sharing-ledger': { drainSharingLedger }, '../../features/sharing/v2/payload-schema': { V2_SCHEDULER_VERSION },
      '../../features/sharing/v2/bootstrap': { v2GroupBootstrap }, '../../features/sharing/group-clock': { sharedLocalDate },
      '../storage/sharing-v2-personal-copy': storeModule, '../../features/sharing/v2/personal-copy-runtime': runtimeModule,
      '../../features/sharing/crypto': { sharedDocumentDigest }, '../../features/sharing/v2/common-plan': { buildV2CommonPlan },
    });
    const qa = await module.createV2PersonalCopyPreview(); const initial = await qa.runtime.load();
    await qa.runtime.prepare(0, initial.choices.map(choice => choice.id), 'common');
    const reviewProof = await qa.inspect(); assert.match(reviewProof, /確認中・共有追加なし/u);
    const saved = await qa.runtime.load(); await qa.runtime.confirm(saved.control.review);
    const committedProof = await qa.inspect(); assert.match(committedProof, /追加済み・二重追加なし/u);
    const reopened = await module.createV2PersonalCopyPreview(); assert.equal(await reopened.inspect(), committedProof);
    assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { h.connection.close(); if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
