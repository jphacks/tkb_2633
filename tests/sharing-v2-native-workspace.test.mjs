import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { workspaceHarness } from './helpers/sharing-workspaces-harness.mjs';
import { readSharingWorkspace, updateSharingWorkspace } from '../src/platform/storage/sharing-registry.ts';
import { approveSharedDevice, upgradeSharedRoster } from '../src/features/sharing/roster.ts';
import { rosterCloudFields } from '../src/features/sharing/cloud-contract.ts';
import { signSharedDocument } from '../src/features/sharing/crypto.ts';

test('native v2 workspace factory chooses its isolated session and never registers a legacy planner adapter', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); assert.equal(workspace.protocol, 2);
    assert.equal('adapter' in workspace, false); assert.deepEqual(h.calls, [['v2-open', 'owner', h.record.groupId, undefined]]);
    const overview = await workspace.readOverview(); assert.equal(overview.timeZone, 'Asia/Tokyo'); assert.equal(overview.chores.length, 20);
    assert.equal(overview.members[0].displayName, '自分');
    assert.equal(h.handles[1].connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0, 'legacy materialized rows stay empty');
    assert.equal((await workspace.checkpoint()).pendingCount, 23);
    await h.api.saveSharingSelection(h.record); assert.deepEqual(JSON.parse(h.vault.get('active-workspace')), { userId: 'owner', groupId: h.record.groupId });
    h.auth.uid = 'other'; await assert.rejects(workspace.readOverview(), /切り替わり/u);
  } finally { await h.close(); }
});
test('a pending signed invitation never opens a guessed database or reads a group key before approval', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness({ pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); assert.equal(workspace.protocol, null); assert.equal(workspace.database, null);
    assert.equal((await workspace.sync({ force: true })).waitingForApproval, true); assert.deepEqual(h.calls, ['join']);
    assert.equal(h.handles.length, 1); assert.equal(workspace.manager, null); assert.equal((await workspace.checkpoint()).pendingCount, 0);
    await assert.rejects(h.api.saveSharingSelection(h.record), /承認/u); assert.equal(h.vault.has('active-workspace'), false);
    assert.deepEqual((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).rosterArchive, []);
  } finally { await h.close(); }
});
test('a verified pending approval opens v2 only after discovery and does not activate an empty uninitialized group', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness({ pending: true });
  try {
    const waiting = await h.api.openSharedWorkspace(h.record); const next = approveSharedDevice(h.initial, h.owner, 'member', h.identity);
    const metadata = { roster: next, group: { ...rosterCloudFields(next), headSequence: 0, lastOperationId: null, snapshotId: null, snapshotThroughSequence: 0 } };
    h.cloud.readGroup = async () => metadata; h.cloud.readRoster = async () => h.initial;
    // No business events are published in this deliberately incomplete transport fixture.
    h.cloud.pull = async () => ({ ...metadata, events: [], throughSequence: 0 }); h.groupKeys.set(2, new Uint8Array(32).fill(1));
    h.cloud.acknowledge = async () => {};
    const result = await waiting.sync({ force: true }); assert.equal(result.complete, false);
    assert.equal((await h.api.openSharedWorkspace(h.record)).protocol, 2);
    assert.equal(h.handles.length, 2); assert.equal(h.calls.includes('legacy-open'), false);
    assert.equal((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).status, 'joining');
    await assert.rejects(h.api.saveSharingSelection(h.record), /承認/u);
  } finally { await h.close(); }
});
test('pending protocol discovery stops an account switch before saving membership or opening any chore database', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness({ pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    h.cloud.readGroup = async () => { h.auth.uid = 'other'; return { roster: h.initial }; };
    await assert.rejects(workspace.sync({ force: true }), /切り替わり/u);
    assert.equal(h.handles.length, 1); assert.deepEqual((await readSharingWorkspace(h.index.database, 'member', h.record.groupId)).rosterArchive, []);
  } finally { await h.close(); }
});
test('a departed v2 session cannot save new operations while all prior signed history remains stored', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, status: 'left' }));
    await workspace.record();
    await assert.rejects(workspace.session.repository.commit([{ operationId: 'forbidden', entityType: 'chore', entityId: 'x', operationType: 'patch', payload: { name: '変更' } }]));
    assert.equal((await workspace.checkpoint()).pendingCount, 23);
  } finally { await h.close(); }
});
test('v2 UI commands recheck a stored version or access failure while cached data remains readable and retry does not invent edits', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const chore = (await workspace.readOverview()).chores[0];
    for (const code of ['sharing/scheduler-version-mismatch', 'permission-denied']) {
      await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, lastErrorCode: code }));
      for (const command of Object.values(workspace.session.controller.actions)) await assert.rejects(command());
      assert.equal((await workspace.checkpoint()).pendingCount, 23); assert.equal((await workspace.readOverview()).chores.find((item) => item.id === chore.id).name, chore.name);
    }
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, lastErrorCode: null }));
    await workspace.session.controller.actions.patchChore(chore.id, { name: '所属を確認した後の変更' });
    assert.equal((await workspace.checkpoint()).pendingCount, 24);
    assert.equal((await workspace.readOverview()).chores.find((item) => item.id === chore.id).name, '所属を確認した後の変更');
  } finally { await h.close(); }
});
test('an unsupported signed protocol during invitation discovery preserves the pin and never opens a database or reads a key', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness({ pending: true });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record); const approved = approveSharedDevice(h.initial, h.owner, 'member', h.identity);
    const body = { ...approved.body, schedulerVersion: 'future-v2-unsupported' };
    const future = { body, signer: approved.signer, signature: signSharedDocument({ domain: 'liflow-shared-roster-v1', body }, h.owner) };
    h.cloud.readGroup = async () => ({ roster: future }); h.cloud.readRoster = async () => h.initial;
    await assert.rejects(workspace.sync({ force: true }), { code: 'sharing/scheduler-version-mismatch' });
    assert.equal(h.handles.length, 1); assert.equal(h.calls.includes('read-key'), false);
    const record = await readSharingWorkspace(h.index.database, 'member', h.record.groupId);
    assert.deepEqual(record.anchor, h.record.anchor); assert.deepEqual(record.rosterArchive, []);
  } finally { await h.close(); }
});

test('normal workspace dispatch refuses an unprepared v1 upgrade before opening either database format', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness({ version: 1 });
  try {
    const upgraded = upgradeSharedRoster(h.initial, h.owner);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, (record) => ({ ...record, rosterArchive: [h.initial, upgraded] }));
    await assert.rejects(h.api.openSharedWorkspace(h.record), { code: 'sharing/v2-migration-required' });
    assert.equal(h.handles.length, 1); assert.deepEqual(h.calls, []);
    const record = await readSharingWorkspace(h.index.database, 'owner', h.record.groupId); assert.deepEqual(record.anchor, h.initial);
  } finally { await h.close(); }
});

test('normal v2 workspace commits refresh its local reminders and retain the real account and group guard', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    const chore = (await workspace.readOverview()).chores[0]; await workspace.session.controller.actions.patchChore(chore.id, { name: '通知経路の検査用' });
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(h.reminderCalls.filter(value => value === 'factory').length, 1); assert.ok(h.reminderCalls.includes('sync'));
    const runtime = await workspace.reminders(); assert.equal((await runtime.store.read()).preferences.enabled, false);
    assert.equal(h.reminderCalls.includes('permission'), false); assert.equal('adapter' in workspace, false);
    h.auth.uid = 'other'; await assert.rejects(runtime.synchronize(), /切り替わり/u);
    assert.equal(h.handles[1].connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { await h.close(); }
});

test('a bounded v2 worker does not launch an independent notification pass after its cloud budget expires', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const previousNow = Date.now; let now = previousNow();
  Date.now = () => now;
  let reads = 0;
  const h = await workspaceHarness({ cloud: { readGroup: async () => { reads++; now += 30_000; throw new Error('cloud unavailable after deadline'); } } });
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    const attempts = Array.from({ length: 100 }, () => workspace.sync({ budgetMs: 1_000 }));
    assert.equal(new Set(attempts).size, 1); await assert.rejects(attempts[0], /cloud unavailable/u);
    for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(h.reminderCalls.includes('factory'), false, 'the coordinator owns the remaining worker budget');
    assert.equal(h.reminderCalls.includes('sync'), false);
    assert.equal(h.taskCalls.length, 0);
    t.mock.timers.tick(1_000); for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(reads, 1, 'coalesced worker requests retain their original deadline after the first pass');
  } finally { Date.now = previousNow; await h.close(); }
});

test('disconnecting a legacy Google workspace preserves a paused v2 connection on the same Native account', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    h.vault.set('sharing-enabled', 'true'); h.taskControl.state = { enabled: false, disconnected: false, accountSubject: 'synthetic-google' };
    assert.equal(await h.api.hasOtherGoogleWorkspaceConnections({}), true);
    h.taskControl.state.disconnected = true; assert.equal(await h.api.hasOtherGoogleWorkspaceConnections({}), false);
    assert.equal(h.calls.includes('legacy-open'), false);
  } finally { await h.close(); }
});

test('loading the v2 Tasks runtime consumes the original worker budget before any Google synchronization starts', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const previous = Date.now; let now = previous(); Date.now = () => now;
  const h = await workspaceHarness();
  try {
    const workspace = await h.api.openSharedWorkspace(h.record);
    await updateSharingWorkspace(h.index.database, 'owner', h.record.groupId, value => ({ ...value, status: 'active' })); await workspace.record();
    h.vault.set('sharing-enabled', 'true'); let syncs = 0;
    workspace.sync = async () => ({}); workspace.maintainHistory = async () => {};
    workspace.reminders = async () => ({ synchronize: async () => {} });
    workspace.googleTasks = async () => { now += 30_000; return { synchronize: async () => { syncs++; } }; };
    await h.api.syncKnownSharingWorkspaces(20_000); assert.equal(syncs, 0);
  } finally { Date.now = previous; await h.close(); }
});

test('a local commit during a bounded v2 sync cannot escape the worker through its debounce callback', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); const previousNow = Date.now; let now = previousNow();
  Date.now = () => now; let workspace; let choreId; let reads = 0;
  const h = await workspaceHarness({ cloud: { readGroup: async () => {
    reads++; await workspace.session.controller.actions.patchChore(choreId, { name: 'worker中の保存' });
    now += 30_000; throw new Error('cloud unavailable after commit');
  } } });
  try {
    workspace = await h.api.openSharedWorkspace(h.record); choreId = (await workspace.readOverview()).chores[0].id;
    await assert.rejects(workspace.sync({ budgetMs: 1_000 }), /cloud unavailable/u);
    t.mock.timers.tick(1_000); for (let i = 0; i < 12; i++) await new Promise(setImmediate);
    assert.equal(reads, 1); assert.equal(h.reminderCalls.includes('factory'), false);
    assert.equal((await workspace.readOverview()).chores.find(row => row.id === choreId).name, 'worker中の保存', 'the local edit stays durable for the next sync');
  } finally { Date.now = previousNow; await h.close(); }
});
