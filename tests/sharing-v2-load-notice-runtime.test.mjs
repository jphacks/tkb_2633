import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, scope, now } from './helpers/sharing-v2-repository-fixture.mjs';
import { createDatabase } from './helpers/sqlite.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { assessV2UntimedDailyLoad } from '../src/features/sharing/v2/daily-load.ts';
import { createV2ReminderStore } from '../src/platform/storage/sharing-v2-reminders.ts';
import { createV2LoadNoticeStore } from '../src/platform/storage/sharing-v2-load-notices.ts';
import { createV2LoadNoticeRuntime } from '../src/features/sharing/v2/load-notice-runtime.ts';

const day = '2026-10-27'; const limits = { heavyDailyLimit: 1, normalDailyLimit: 1 };
async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds());
  let active = true; let permitted = true; let elapsed = 0; let instant = now(); let hook; const presented = []; let fullReads = 0;
  const assertAccess = () => { if (!active) throw new Error('account changed'); };
  const controller = createV2GroupController(d.repository, { now, makeId: () => 'unused', sync: async () => {} });
  const preferences = createV2ReminderStore(d.database, { ...scope, assertAccess });
  const control = await preferences.save(0, { enabled: true, hour: 9, minute: 0 });
  const model = await controller.readModel({ from: day, through: day, asOfDate: day });
  let current = assessV2UntimedDailyLoad({ model, userId: scope.userId, limits });
  const store = createV2LoadNoticeStore(d.database, { ...scope, assertAccess });
  const input = { ...scope, store, assertAccess, hasPermission: async () => permitted, readControl: preferences.read,
    readCurrent: async () => { fullReads++; await hook?.(); return { assessment: current, control: await preferences.read() }; },
    now: () => instant, budgetNow: () => elapsed,
    present: async (notice, guard, beforePresent) => { await guard(); if (await beforePresent()) { await guard(); presented.push(notice); } },
  };
  const runtime = createV2LoadNoticeRuntime(input);
  return { d, control, model, preferences, store, input, runtime, presented, fullReads: () => fullReads,
    synchronize: () => runtime.synchronize(current, control), assessment: () => current,
    current(value) { current = value; }, permit(value) { permitted = value; }, stop() { active = false; },
    clock(value) { elapsed = value; }, now(value) { instant = value; }, hook(value) { hook = value; }, close: () => d.connection.close() };
}
const markerExists = (h) => Boolean(h.d.connection.prepare("SELECT 1 FROM sqlite_master WHERE name='sharing_v2_private_load_notices'").get());

test('untimed load notifications coalesce one hundred requests and retain one private daily marker across runtime restart', async () => {
  const h = await setup(); try {
    const before = await h.d.repository.readState();
    const first = h.synchronize(); for (let i = 0; i < 100; i++) assert.equal(h.synchronize(), first); await first;
    assert.equal(h.presented.length, 1); assert.equal(h.fullReads(), 1, 'full private planning runs once, not on each queue guard');
    assert.equal(await h.store.seen(day), true);
    await createV2LoadNoticeRuntime(h.input).synchronize(h.assessment(), h.control); assert.equal(h.presented.length, 1);
    const after = await h.d.repository.readState(); assert.deepEqual(after.replica.operations, before.replica.operations);
    assert.deepEqual(after.receipts, before.receipts);
    assert.deepEqual(after.assessment.pendingOutboxIds, before.assessment.pendingOutboxIds);
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
  } finally { h.close(); }
});

test('load alerts stay opt-in and denied permission or below-limit work creates no durable marker', async () => {
  const h = await setup(); try {
    h.permit(false); await h.synchronize(); assert.equal(markerExists(h), false); assert.equal(h.presented.length, 0);
    h.permit(true); const below = { ...h.assessment(), scopes: h.assessment().scopes.map(row => ({ ...row, reached: [], exceeded: [] })) };
    await h.runtime.synchronize(below, h.control); assert.equal(markerExists(h), false);
    const disabled = await h.preferences.save(1, { enabled: false, hour: 9, minute: 0 });
    await h.runtime.synchronize(h.assessment(), disabled); assert.equal(markerExists(h), false); assert.equal(h.fullReads(), 0);
  } finally { h.close(); }
});

test('load notifications revalidate changed private counts limits and settings before reserving the one daily alert', async () => {
  const h = await setup(); try {
    h.hook(() => h.current({ ...h.assessment(), revision: 'a'.repeat(64) }));
    await assert.rejects(h.synchronize(), /負荷が変わり/u); assert.equal(markerExists(h), false); assert.equal(h.presented.length, 0);
    h.hook(undefined);
    const disabled = await h.preferences.save(1, { enabled: false, hour: 9, minute: 0 });
    await assert.rejects(h.synchronize(), /通知設定が変わり/u); assert.equal(markerExists(h), false);
    assert.equal(disabled.revision, 2);
  } finally { h.close(); }
});

test('load notification rejects a stale civil day changed account foreign owner and exhausted worker budget without a native write', async () => {
  const h = await setup(); try {
    await assert.rejects(h.runtime.synchronize({ ...h.assessment(), userId: 'member' }, h.control), /本人・グループ/u);
    await assert.rejects(h.runtime.synchronize({ ...h.assessment(), groupId: 'elsewhere' }, h.control), /本人・グループ/u);
    h.now(new Date('2026-10-27T15:00:00Z')); await assert.rejects(h.synchronize(), /通知設定が変わり/u);
    h.now(now()); h.hook(() => h.clock(1000));
    await assert.rejects(h.runtime.synchronize(h.assessment(), h.control, 500), /次回の同期/u); assert.equal(markerExists(h), false);
    h.hook(undefined); h.stop(); await assert.rejects(h.synchronize(), /account changed/u);
    assert.equal(h.presented.length, 0);
  } finally { h.close(); }
});

test('a shorter shared-worker budget fences an already queued load notification and cannot start another worker', async () => {
  const h = await setup(); let release;
  try {
    let entered; const ready = new Promise(resolve => { entered = resolve; }); const pending = new Promise(resolve => { release = resolve; });
    h.hook(async () => { entered(); await pending; }); const work = h.runtime.synchronize(h.assessment(), h.control, 5000); await ready;
    assert.equal(h.runtime.synchronize(h.assessment(), h.control, 10), work); h.clock(11); release();
    await assert.rejects(work, /次回の同期/u); assert.equal(h.presented.length, 0); assert.equal(markerExists(h), false);
  } finally { release?.(); h.close(); }
});

test('real SQLite daily load claims are exclusive across callers and reject obsolete preference or group revisions', async () => {
  const h = await setup(); try {
    const guard = async () => {};
    await assert.rejects(h.store.claim(day, h.assessment().revision, { ...h.control, revision: 99 }, guard), /設定・予定/u);
    await assert.rejects(h.store.claim(day, h.assessment().revision, { ...h.control, groupRevision: 'changed' }, guard), /設定・予定/u);
    assert.equal(markerExists(h), false);
    const values = await Promise.all(Array.from({ length: 20 }, () => h.store.claim(day, h.assessment().revision, h.control, guard)));
    assert.equal(values.filter(Boolean).length, 1); assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM sharing_v2_private_load_notices').get().n, 1);
    const restarted = createV2LoadNoticeStore(h.d.database, { ...scope, assertAccess() {} }); assert.equal(await restarted.seen(day), true);
  } finally { h.close(); }
});

test('daily load marker transaction rolls back if authority disappears after insertion and never initializes a personal database', async () => {
  const h = await setup(); const personal = createDatabase();
  try {
    let calls = 0; await assert.rejects(h.store.claim(day, h.assessment().revision, h.control, async () => { if (++calls === 2) throw new Error('scope changed'); }), /scope changed/u);
    assert.equal(markerExists(h), false, 'transactional table and marker are both rolled back');
    const wrong = createV2LoadNoticeStore(h.d.database, { ...scope, userId: 'member', assertAccess() {} }); await assert.rejects(wrong.seen(day), /保存先/u);
    const tables = personal.connection.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
    const store = createV2LoadNoticeStore(personal.database, { ...scope, assertAccess() {} });
    await assert.rejects(store.seen(day)); assert.deepEqual(personal.connection.prepare('SELECT name FROM sqlite_master ORDER BY name').all(), tables);
    await assert.rejects(h.store.claim('2026-02-30', h.assessment().revision, h.control, async () => {}));
    await assert.rejects(h.store.claim(day, 'bad', h.control, async () => {}));
  } finally { personal.connection.close(); h.close(); }
});

test('uncertain OS delivery retains its private claim to avoid duplicate alerts while a new civil day may alert once', async () => {
  const h = await setup(); try {
    const failed = createV2LoadNoticeRuntime({ ...h.input, present: async (_notice, guard, before) => { await guard(); await before(); throw new Error('OS response lost'); } });
    await assert.rejects(failed.synchronize(h.assessment(), h.control), /OS response lost/u); assert.equal(await h.store.seen(day), true);
    await h.synchronize(); assert.equal(h.presented.length, 0);
    const next = '2026-10-28'; const model = { ...h.model, plan: { ...h.model.plan, range: { from: next, through: next, asOfDate: next } } };
    h.current(assessV2UntimedDailyLoad({ model, userId: scope.userId, limits, privateOverlay: {
      status: 'ready', ownerUserId: scope.userId, today: next, timeZone: 'Asia/Tokyo', dailyLoad: { [next]: { heavy: 0, normal: 1, total: 1 } },
    } })); h.now(new Date('2026-10-28T01:00:00Z')); await h.synchronize(); assert.equal(h.presented.length, 1);
  } finally { h.close(); }
});

test('queued load notification captures its displayed assessment and preferences before an asynchronous boundary', async () => {
  const h = await setup(); let release;
  try {
    let entered; const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
    const original = structuredClone(h.assessment()); const displayed = structuredClone(original); const control = structuredClone(h.control);
    const runtime = createV2LoadNoticeRuntime({ ...h.input, assertAccess: async () => { entered(); await gate; },
      readCurrent: async () => ({ assessment: original, control: h.control }) });
    const work = runtime.synchronize(displayed, control); await ready;
    displayed.scopes[0].reached.length = 0; displayed.scopes[0].load.normal = 999; control.preferences.enabled = false;
    release(); await work; assert.equal(h.presented.length, 1); assert.ok(!h.presented[0].body.includes('999'));
  } finally { release?.(); h.close(); }
});

test('a private cache becoming available in another timezone cannot deliver a second load alert on the same group day', async () => {
  const h = await setup(); try {
    await h.synchronize(); assert.equal(h.presented.length, 1);
    h.current(assessV2UntimedDailyLoad({ model: h.model, userId: scope.userId, limits, privateOverlay: {
      status: 'ready', ownerUserId: scope.userId, today: '2026-10-26', timeZone: 'America/Los_Angeles', dailyLoad: { '2026-10-26': { heavy: 1, normal: 0, total: 1 } },
    } }));
    await createV2LoadNoticeRuntime(h.input).synchronize(h.assessment(), h.control);
    assert.equal(h.presented.length, 1); assert.equal(await h.store.seen(day), true); assert.equal(await h.store.seen('2026-10-26'), false);
  } finally { h.close(); }
});
