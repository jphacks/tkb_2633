import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { now } from './helpers/sharing-v2-repository-fixture.mjs';
const { createV2GoogleTaskRuntime } = await import('../src/features/sharing/v2/google-tasks-runtime.ts');
const turn = () => new Promise(setImmediate);

async function setup() {
  const h = await googleFixture(); const calls = []; let subject = 'synthetic-google-subject'; let currentContext;
  const runtime = createV2GoogleTaskRuntime({ store: h.store, now, assertAccess: h.scope.assertAccess,
    restoreAccount: async () => { calls.push('restore'); return { subject, label: '検査用のGoogle' }; },
    currentSubject: async () => subject, authorizeTasks: async () => { calls.push('authorize'); }, token: async expected => { assert.equal(expected, subject); calls.push('token'); return 'synthetic-token'; },
    preparePlan: async () => { calls.push('prepare'); }, createApi: context => { currentContext = context; return h.api; },
  });
  return { ...h, runtime, nativeCalls: calls, account(value) { subject = value; }, context: () => currentContext };
}

test('v2 Tasks runtime stays offline and never restores OAuth or reads private planner input when unconfigured', async () => {
  const h = await setup(); try {
    assert.equal((await h.runtime.readControl()).state, null);
    assert.deepEqual(await h.runtime.synchronize(), { kind: 'success', skipped: true });
    assert.deepEqual(h.nativeCalls, []); assert.deepEqual(h.calls, []);
  } finally { h.close(); }
});

test('v2 Tasks connection requires explicit account review and grants only the reviewed account without auto-sync', async () => {
  const h = await setup(); try {
    const review = await h.runtime.reviewConnection(); assert.deepEqual(h.nativeCalls, ['restore']); assert.equal((await h.runtime.readControl()).state, null);
    await h.runtime.connect(review); assert.deepEqual(h.nativeCalls, ['restore', 'authorize']); assert.equal((await h.runtime.readControl()).state.enabled, true); assert.equal(h.tasks.size, 0);
    const result = await h.runtime.synchronize({ force: true }); assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    assert.deepEqual(h.nativeCalls, ['restore', 'authorize', 'prepare', 'token']);
  } finally { h.close(); }
});

test('v2 Tasks refuses an account switched after review before requesting a grant or saving a binding', async () => {
  const h = await setup(); try {
    const review = await h.runtime.reviewConnection(); h.account('different-subject');
    await assert.rejects(h.runtime.connect(review), { code: 'google_account_mismatch' }); assert.deepEqual(h.nativeCalls, ['restore']);
    assert.equal((await h.runtime.readControl()).state, null);
  } finally { h.close(); }
});

test('v2 Tasks coalesces100 simultaneous syncs, recovers a fresh interrupted marker and keeps the same remote IDs', async () => {
  const h = await setup(); try {
    await h.connect(); const attempts = Array.from({ length: 100 }, () => h.runtime.synchronize({ force: true }));
    assert.equal(new Set(attempts).size, 1); assert.equal((await attempts[0]).created, 3);
    assert.equal(h.nativeCalls.filter(value => value === 'token').length, 1);
    const ids = [...h.tasks.keys()]; const before = await h.store.readControl();
    await h.store.saveSyncState({ ...before.state, status: 'syncing', lastAttemptAt: now().toISOString() }, before.revision);
    h.calls.length = 0; const restored = await h.runtime.synchronize({ force: true }); assert.equal(restored.kind, 'success');
    assert.equal(restored.skipped, undefined); assert.deepEqual([...h.tasks.keys()], ids); assert.equal(h.calls.length, 0);
  } finally { h.close(); }
});

test('v2 Tasks detects a Native account switch during HTTP before importing or storing old-account results', async () => {
  const h = await setup(); try {
    await h.connect(); h.hooks.beforeRead = async () => { h.account('different-subject'); };
    const result = await h.runtime.synchronize({ force: true }); assert.deepEqual(result, { kind: 'authRequired', code: 'google_account_mismatch' });
    assert.equal(h.tasks.size, 0); assert.equal((await h.links()).length, 0); assert.equal((await h.store.readControl()).state.accountSubject, 'synthetic-google-subject');
  } finally { h.close(); }
});

test('v2 Tasks receives a local undo during PATCH and follows it up before its shared sync promise finishes', async () => {
  const h = await setup(); try {
    await h.connect(); await h.runtime.synchronize({ force: true }); const item = (await h.entries())[0]; const [done] = await h.actions.complete(item.target);
    h.hooks.afterPatch = async () => { delete h.hooks.afterPatch; await h.actions.undo(done.operationId); h.runtime.synchronize({ localChange: true }); };
    assert.equal((await h.runtime.synchronize({ force: true })).kind, 'success');
    const link = (await h.links()).find(row => row.scheduleEntryId === item.entry.id);
    assert.equal(link.pendingStatus, undefined); assert.equal(h.tasks.get(link.googleTaskId).status, 'needsAction');
  } finally { h.close(); }
});

test('v2 Tasks timeout bounds its caller while a late HTTP result remains fenced and coalesced until it settles', async () => {
  const h = await setup(); let release; let started; const ready = new Promise(resolve => { started = resolve; });
  try {
    await h.connect(); const waiting = new Promise(resolve => { release = resolve; });
    h.hooks.beforeRead = async () => { started(); await waiting; };
    const first = h.runtime.synchronize({ force: true, budgetMs: 1000 }); await ready;
    const joined = h.runtime.synchronize({ budgetMs: 20 }); assert.equal(first, joined);
    assert.deepEqual(await first, { kind: 'retry', code: 'timeout' }); assert.equal(h.context().budget.signal.aborted, true);
    assert.equal(h.runtime.synchronize(), first, 'late requests do not open a second sync beside an unsettled operation');
    release(); for (let i = 0; i < 20; i++) await turn(); assert.equal(h.tasks.size, 0); assert.equal((await h.store.readControl()).state.status, 'retryPending');
  } finally { release?.(); h.close(); }
});

test('v2 Tasks pause stops an in-flight budget, keeps mappings, and never signs out another Google workspace', async () => {
  const h = await setup(); let release; let started; const ready = new Promise(resolve => { started = resolve; });
  try {
    await h.connect(); await h.runtime.synchronize({ force: true }); const links = await h.links();
    const waiting = new Promise(resolve => { release = resolve; }); h.hooks.beforeRead = async () => { started(); await waiting; };
    const work = h.runtime.synchronize({ force: true }); await ready; const control = await h.store.readControl(); const stop = h.runtime.pause(control.revision, true);
    assert.equal(h.context().budget.signal.aborted, true); release(); await work; await stop;
    const after = await h.store.readControl(); assert.equal(after.state.enabled, false); assert.equal(after.state.disconnected, true);
    assert.deepEqual(await h.links(), links); assert.equal(h.nativeCalls.some(call => call.includes('sign-out')), false);
    assert.deepEqual(await h.runtime.synchronize(), { kind: 'success', skipped: true });
  } finally { release?.(); h.close(); }
});

test('v2 Tasks uses the shared region day for its fourteen-day window when the device day differs', async () => {
  const prior = process.env.TZ; process.env.TZ = 'UTC';
  const clock = () => new Date('2026-10-26T16:00:00.000Z');
  const h = await googleFixture({ clock });
  try {
    await h.connect();
    const runtime = createV2GoogleTaskRuntime({ store: h.store, now: clock, assertAccess: h.scope.assertAccess,
      currentSubject: async () => 'synthetic-google-subject', token: async () => 'synthetic-token',
      restoreAccount: async () => { throw new Error('No interactive OAuth in automatic sync'); },
      authorizeTasks: async () => { throw new Error('No interactive OAuth in automatic sync'); }, createApi: () => h.api });
    const result = await runtime.synchronize({ force: true });
    assert.equal(result.kind, 'success'); assert.equal(result.created, 3);
    assert.ok([...h.tasks.values()].some(task => task.due.startsWith('2026-11-10')));
  } finally { h.close(); if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
