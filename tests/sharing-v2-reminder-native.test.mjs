import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadNativeModule } from './helpers/native-module.mjs';
import { fixture, seeds, scope } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import * as storeModule from '../src/platform/storage/sharing-v2-reminders.ts';
import * as runtimeModule from '../src/features/sharing/v2/reminder-runtime.ts';
import * as screenModule from '../src/features/sharing/v2-ui/screen-session.ts';
import * as overlayModule from '../src/features/sharing/v2-ui/private-overlay.ts';
import * as ownerModule from '../src/features/sharing/v2-ui/owner-preferences.ts';
import * as reconciliation from '../src/features/notifications/reconcile-local-notifications.ts';
import * as identity from '../src/features/sharing/v2/native-identity.ts';
import * as personalPlan from '../src/features/sharing/v2/personal-plan.ts';
import * as cryptoModule from '../src/features/sharing/crypto.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';

async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds());
  const calls = []; const scheduled = new Map(); let active = true; let failPersonal = false;
  const guard = () => { if (!active) throw new Error('account changed'); };
  const gateway = { maximumScheduledRequests: 60, async requestPermission() { calls.push('request-permission'); return true; }, async hasPermission() { return true; },
    async getScheduledRequests() { return [...scheduled.values()]; }, async schedule(request) { scheduled.set(request.key, request); return request.key; }, async cancel(key) { scheduled.delete(key); } };
  const personal = { async closeAsync() { calls.push('personal-close'); } };
  const controller = createV2GroupController(d.repository, { now: () => new Date(), makeId: () => 'unused-id', sync: async () => {} });
  const nativeMocks = {
    'expo-sqlite': { async openDatabaseAsync(name, options) { assert.equal(name, 'housework.db'); assert.equal(options.useNewConnection, true); calls.push('personal-open'); return personal; } },
    '../storage/repository': { async readPersonalPlannerOverlaySnapshot(db, now) { assert.equal(db, personal); calls.push('personal-read'); if (failPersonal) { active = false; }
      return { today: sharedLocalDate(now, 'Asia/Tokyo'), timeZone: 'Asia/Tokyo', snapshot: { household: { id: 'local-household' },
        settings: { frequencyMode: 'balanced', restDays: [], heavyDailyLimit: 1, normalDailyLimit: 2, setupCompleted: true }, chores: [], scheduleEntries: [], completions: [] } }; } },
    '../storage/sharing-v2-reminders': storeModule, '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
    '../../features/sharing/v2/reminder-runtime': runtimeModule, '../../features/sharing/v2-ui/screen-session': screenModule,
    '../../features/sharing/v2-ui/private-overlay': overlayModule, '../../features/sharing/v2-ui/owner-preferences': ownerModule,
    '../../features/sharing/v2/personal-plan': personalPlan, '../../features/sharing/crypto': cryptoModule,
    '../../features/notifications/reconcile-local-notifications': reconciliation, '../../features/sharing/v2/native-identity': identity,
    './private-calendar-runtime': { openPrivateCalendarRuntime(uid) { assert.equal(uid, scope.userId); guard(); calls.push('local-calendar');
      return { async readPlannerPreferences() { guard(); return null; }, async readForPlan() { guard(); return null; }, async readOwnCalendar() { throw new Error('notification rendering must not acquire Google'); } }; } },
    './v2-completion-notices': { createNativeV2CompletionNotices(input) { assert.equal(input.repository, d.repository); return { synchronize: async () => {} }; },
      clearInactiveV2CompletionNotices: async () => {}, clearV2CompletionNoticesForScope: async () => {} },
  };
  nativeMocks['./v2-local-planning'] = loadNativeModule('src/platform/sharing/v2-local-planning.ts', nativeMocks);
  const module = loadNativeModule('src/platform/sharing/v2-reminders.ts', nativeMocks);
  const runtime = module.createNativeV2Reminders({ ...scope, database: d.database, repository: d.repository, controller, assertAccess: guard });
  return { f, d, module, runtime, calls, scheduled, stopDuringPersonalRead() { failPersonal = true; }, close() { d.connection.close(); } };
}

test('native v2 reminders default off without permission, personal-data read or OAuth, then reuse owner-only planning', async () => {
  const h = await setup(); try {
    await h.runtime.synchronize(); assert.deepEqual(h.calls, []);
    await h.runtime.store.save(0, { enabled: true, hour: 10, minute: 0 }); await h.runtime.synchronize(); assert.ok(h.scheduled.size > 0);
    assert.deepEqual(h.calls, ['personal-open', 'personal-read', 'local-calendar', 'personal-close']);
    assert.ok([...h.scheduled.values()].every(row => row.key.startsWith(identity.v2NotificationPrefix(scope.userId, scope.groupId))));
    assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0, 'v2 stays out of legacy planner rows');
    assert.equal(h.calls.includes('request-permission'), false);
  } finally { h.close(); }
});

test('native v2 reminders close the personal handle and reject account changes during private read before native writes', async () => {
  const h = await setup(); try {
    await h.runtime.store.save(0, { enabled: true, hour: 10, minute: 0 }); h.stopDuringPersonalRead();
    await assert.rejects(h.runtime.synchronize(), /account changed/u); assert.deepEqual(h.calls, ['personal-open', 'personal-read', 'personal-close']); assert.equal(h.scheduled.size, 0);
  } finally { h.close(); }
});

test('native v2 cleanup retains valid current-account scopes and never cancels personal or v1 notifications', async () => {
  const h = await setup(); try {
    const valid = identity.v2NotificationPrefix(scope.userId, scope.groupId) + 'today'; const stale = identity.v2NotificationPrefix('previous-account', scope.groupId) + 'today';
    for (const key of [valid, stale, 'housework-digest:today', 'liflow-group-digest:' + 'a'.repeat(64) + ':today']) h.scheduled.set(key, { key, title: '', body: '', fireAt: '2026-10-30T00:00:00Z' });
    await h.module.clearInactiveV2Reminders([scope]); assert.equal(h.scheduled.has(stale), false); assert.equal(h.scheduled.size, 3); assert.ok(h.scheduled.has(valid));
    await assert.rejects(h.module.clearInactiveV2Reminders([], () => { throw new Error('superseded account'); }), /superseded account/u); assert.equal(h.scheduled.size, 3);
    await h.module.clearV2RemindersForScope(scope.userId, scope.groupId); assert.equal(h.scheduled.size, 2);
  } finally { h.close(); }
});
