import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, seeds, scope } from './helpers/sharing-v2-repository-fixture.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { createV2ReminderStore } from '../src/platform/storage/sharing-v2-reminders.ts';
import { assessV2UntimedDailyLoad } from '../src/features/sharing/v2/daily-load.ts';
import { sharedLocalDate } from '../src/features/sharing/group-clock.ts';
import { notificationWorkspace, isPlannerNotification } from '../src/features/notifications/workspace-response.ts';
import * as storeModule from '../src/platform/storage/sharing-v2-load-notices.ts';
import * as runtimeModule from '../src/features/sharing/v2/load-notice-runtime.ts';
import * as identities from '../src/features/sharing/v2/native-identity.ts';
import * as localDate from '../src/domain/scheduling/local-date.ts';
import * as queue from '../src/features/notifications/reconcile-local-notifications.ts';

async function setup(platform) {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds());
  let active = true; let permission = true; let channel; let fullReads = 0; const calls = []; const pending = []; const presented = [];
  const assertAccess = () => { if (!active) throw new Error('account changed'); };
  const preferences = createV2ReminderStore(d.database, { ...scope, assertAccess });
  const control = await preferences.save(0, { enabled: true, hour: 9, minute: 0 }); const date = sharedLocalDate(new Date(), 'Asia/Tokyo');
  const controller = createV2GroupController(d.repository, { now: () => new Date(), makeId: () => 'unused', sync: async () => {} });
  const model = await controller.readModel({ from: date, through: date, asOfDate: date });
  const assessment = assessV2UntimedDailyLoad({ model, userId: scope.userId, limits: { heavyDailyLimit: 1, normalDailyLimit: 1 },
    privateOverlay: { status: 'ready', ownerUserId: scope.userId, today: date, timeZone: 'Asia/Tokyo', dailyLoad: { [date]: { heavy: 0, normal: 1, total: 1 } } } });
  const gateway = { maximumScheduledRequests: platform === 'ios' ? 60 : undefined,
    hasPermission: async () => permission, getScheduledRequests: async () => [...pending] };
  const mocks = { 'react-native': { Platform: { OS: platform } },
    '../storage/sharing-v2-load-notices': storeModule, '../../features/sharing/v2/load-notice-runtime': runtimeModule,
    '../../features/sharing/v2/native-identity': identities, '../../domain/scheduling/local-date': localDate,
    '../notifications/expo-local-notification-gateway': { expoLocalNotificationGateway: gateway },
    '../../features/notifications/reconcile-local-notifications': queue,
    'expo-notifications': { AndroidImportance: { DEFAULT: 3 },
      setNotificationChannelAsync: async () => { calls.push('channel'); await channel?.(); },
      scheduleNotificationAsync: async request => { calls.push(request); presented.push({ request: { identifier: request.identifier } }); return request.identifier; },
      getPresentedNotificationsAsync: async () => [...presented],
      cancelScheduledNotificationAsync: async key => { pending.splice(pending.findIndex(item => item.key === key), 1); },
      dismissNotificationAsync: async key => { presented.splice(presented.findIndex(item => item.request.identifier === key), 1); },
    } };
  const presenter = loadNativeModule('src/platform/sharing/v2-immediate-notices.ts', mocks); mocks['./v2-immediate-notices'] = presenter;
  const module = loadNativeModule('src/platform/sharing/v2-load-notices.ts', mocks);
  const runtime = module.createNativeV2LoadNotices({ ...scope, database: d.database, assertAccess, readControl: preferences.read,
    readCurrent: async () => { fullReads++; return { assessment, control: await preferences.read() }; } });
  return { d, control, assessment, runtime, presenter, gateway, calls, pending, presented, preferences,
    synchronize: () => runtime.synchronize(assessment, control), fullReads: () => fullReads,
    channel(work) { channel = work; }, stop() { active = false; }, permit(value) { permission = value; }, close: () => d.connection.close() };
}

for (const platform of ['ios', 'android']) {
  test(`${platform} untimed load Native delivery is owner-scoped opt-in immediate and contains neither chore names nor times`, async () => {
    const h = await setup(platform); try {
      await h.synchronize(); const request = h.calls.find(item => typeof item === 'object'); assert.ok(request);
      assert.deepEqual(request.trigger, platform === 'ios' ? null : { channelId: 'housework-load-warnings' });
      assert.deepEqual(Object.keys(request.content.data).sort(), ['count', 'date', 'kind', 'workspace']);
      assert.equal(request.content.data.kind, 'v2-housework-load'); assert.equal(isPlannerNotification(request.content.data), true);
      assert.deepEqual(notificationWorkspace(request.content.data, scope.userId, [{ ...scope, status: 'active' }]), { userId: scope.userId, groupId: scope.groupId });
      assert.equal(notificationWorkspace(request.content.data, 'member', [{ ...scope, status: 'active' }]), undefined);
      assert.equal(notificationWorkspace(request.content.data, scope.userId, [{ ...scope, status: 'left' }]), undefined);
      assert.ok(!JSON.stringify(request.content).includes('床を掃除する')); assert.ok(!JSON.stringify(request.content).includes('T01:'));
      assert.equal(h.fullReads(), 1); await h.synchronize(); assert.equal(h.fullReads(), 1);
      assert.equal(h.calls.filter(item => typeof item === 'object').length, 1);
    } finally { h.close(); }
  });

  test(`${platform} untimed alert waits for the app-wide queue and rechecks a changed account before claiming or writing`, async () => {
    const h = await setup(platform); let release;
    try {
      let entered; const ready = new Promise(resolve => { entered = resolve; }); const gate = new Promise(resolve => { release = resolve; });
      const previous = queue.withLocalNotificationOperation(h.gateway, async () => { entered(); await gate; }); await ready;
      const work = h.synchronize(); const rejected = assert.rejects(work, /account changed/u);
      await new Promise(setImmediate); h.stop(); release(); await previous; await rejected;
      assert.equal(h.calls.length, 0); assert.equal(h.d.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_private_load_notices'").get().n, 0);
    } finally { release?.(); h.close(); }
  });

  test(`${platform} immediate notice cleanup preserves current personal v1 completion and QA scopes when a load group is removed`, async () => {
    const h = await setup(platform); try {
      const stale = runtimeModule.v2LoadNoticePrefix('departed', scope.groupId); const keep = runtimeModule.v2LoadNoticePrefix(scope.userId, scope.groupId);
      const preserved = [keep + 'a', 'personal', 'liflow-group-digest:old', 'liflow-v2-completed:current', 'liflow-qa-v2-completed:audit'];
      h.pending.push(...[...preserved, stale + 'pending'].map(key => ({ key })));
      h.presented.push(...[...preserved, stale + 'displayed'].map(identifier => ({ request: { identifier } })));
      await h.presenter.clearV2ImmediateNotices(id => id.startsWith(stale), async () => {});
      assert.deepEqual(h.pending.map(row => row.key), preserved); assert.deepEqual(h.presented.map(row => row.request.identifier), preserved);
    } finally { h.close(); }
  });
}

test('Android disabling notifications while a load channel is created prevents both the private marker and OS delivery', async () => {
  const h = await setup('android'); try {
    h.channel(() => h.preferences.save(1, { enabled: false, hour: 9, minute: 0 }));
    await assert.rejects(h.synchronize(), /通知設定が変わり/u); assert.deepEqual(h.calls, ['channel']);
    assert.equal(h.d.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_private_load_notices'").get().n, 0);
  } finally { h.close(); }
});

test('iOS a full native reservation refuses a load alert before claiming the date and preserves all sixty existing reminders', async () => {
  const h = await setup('ios'); try {
    h.pending.push(...Array.from({ length: 60 }, (_, n) => ({ key: `personal-${n}` })));
    await assert.rejects(h.synchronize(), /通知予約上限/u); assert.equal(h.pending.length, 60); assert.equal(h.calls.length, 0); assert.equal(h.fullReads(), 0);
    assert.equal(h.d.connection.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='sharing_v2_private_load_notices'").get().n, 0);
  } finally { h.close(); }
});
