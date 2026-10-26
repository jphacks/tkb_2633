import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

function load(filename, mocks) {
  const { outputText } = ts.transpileModule(readFileSync(new URL(`../${filename}`, import.meta.url), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  });
  const module = { exports: {} };
  Function('require', 'module', 'exports', outputText)((name) => {
    assert.ok(name in mocks, `unmocked native import ${name}`); return mocks[name];
  }, module, module.exports);
  return module.exports;
}

for (const platform of ['ios', 'android']) {
  test(`${platform} notification gateway coalesces permission requests and creates Android channels before asking`, async () => {
    const events = []; let resolve;
    const { ExpoLocalNotificationGateway } = load('src/platform/notifications/expo-local-notification-gateway.ts', {
      'react-native': { Platform: { OS: platform } },
      'expo-notifications': { AndroidImportance: { DEFAULT: 3 },
        setNotificationChannelAsync: async (id) => { events.push(`channel:${id}`); },
        getPermissionsAsync: async () => { events.push('get'); return { granted: false, canAskAgain: true }; },
        requestPermissionsAsync: () => { events.push('ask'); return new Promise((done) => { resolve = done; }); },
      },
    });
    const gateway = new ExpoLocalNotificationGateway();
    const first = gateway.requestPermission(); const second = gateway.requestPermission();
    await new Promise(setImmediate);
    assert.deepEqual(events, platform === 'android' ? ['channel:housework-reminders', 'get', 'ask'] : ['get', 'ask']);
    resolve({ granted: false }); assert.deepEqual(await Promise.all([first, second]), [false, false]);
    const third = gateway.requestPermission(); await new Promise(setImmediate); resolve({ granted: true });
    assert.equal(await third, true); assert.equal(events.filter((event) => event === 'ask').length, 2);
  });

  test(`${platform} notification schedule round trip retains date, identity, subtitle and metadata without duplicates`, async () => {
    const saved = new Map();
    const { ExpoLocalNotificationGateway } = load('src/platform/notifications/expo-local-notification-gateway.ts', {
      'react-native': { Platform: { OS: platform } },
      'expo-notifications': { SchedulableTriggerInputTypes: { DATE: 'date' },
        scheduleNotificationAsync: async (value) => { saved.set(value.identifier, value); return value.identifier; },
        getAllScheduledNotificationsAsync: async () => [...saved.values()],
        cancelScheduledNotificationAsync: async (id) => { saved.delete(id); },
      },
    });
    const gateway = new ExpoLocalNotificationGateway();
    const request = { key: 'housework-digest:2026-10-27', title: '今日の家事', subtitle: '2件の未完了タスク',
      body: '食器を洗う、洗濯する', fireAt: '2026-10-26T23:00:00.000Z', data: { kind: 'daily-housework-digest', date: '2026-10-27' } };
    await gateway.schedule(request); await gateway.schedule(request);
    assert.equal(saved.size, 1);
    assert.equal(saved.get(request.key).trigger.date.toISOString(), request.fireAt);
    assert.equal(saved.get(request.key).trigger.channelId, 'housework-reminders');
    assert.deepEqual(await gateway.getScheduledRequests(), [request]);
    await assert.rejects(gateway.schedule({ ...request, fireAt: 'invalid' }), RangeError);
    await gateway.cancel(request.key); assert.deepEqual(await gateway.getScheduledRequests(), []);
  });

  test(`${platform} appliance API uses the reachable emulator host while preserving an explicit deployment URL`, () => {
    const previous = process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;
    try {
      delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;
      const { applianceCareApiBaseUrl } = load('src/features/appliance-care/api-client.ts', {
        'react-native': { Platform: { OS: platform } },
        '@/features/appliance-care/official-url': {}, './polling': {},
      });
      assert.equal(applianceCareApiBaseUrl(), platform === 'android' ? 'http://10.0.2.2:8787' : 'http://localhost:8787');
      process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = ' https://api.example.test/// ';
      assert.equal(applianceCareApiBaseUrl(), 'https://api.example.test');
    } finally {
      if (previous === undefined) delete process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL;
      else process.env.EXPO_PUBLIC_APPLIANCE_CARE_API_URL = previous;
    }
  });
}

test('native entry defines background work before Router can mount any screens', async () => {
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(packageJson.main, 'index.ts');
  const events = []; let callback;
  const backgroundMocks = {
    'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
    'expo-task-manager': { defineTask: (name, run) => { events.push(`define:${name}`); callback = run; } },
    'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => { events.push('close'); } }) },
    './coordinator': { syncGoogleTasks: async () => { events.push('sync'); } },
    '@/platform/storage/repository': { LOCAL_HOUSEHOLD_ID: 'home', initializeLocalDatabase: async () => { events.push('initialize'); },
      loadGoogleSyncState: async () => ({ enabled: true }) },
  };
  load(packageJson.main, {
    get './src/features/google-sync/background-task'() {
      return load('src/features/google-sync/background-task.ts', backgroundMocks);
    },
    get 'expo-router/entry'() { assert.ok(callback); events.push('router'); return {}; },
  });
  assert.deepEqual(events, ['define:housework-planner-google-tasks-sync', 'router']);
  assert.equal(await callback({}), 'success');
  assert.deepEqual(events.slice(2), ['initialize', 'sync', 'close']);
  assert.equal(await callback({ error: { message: 'OS error' } }), 'failed');
});

test('background tasks close their SQLite connection after a sync failure without mounting UI', async () => {
  let callback; let closed = 0;
  load('src/features/google-sync/background-task.ts', {
    'expo-background-task': { BackgroundTaskResult: { Success: 'success', Failed: 'failed' } },
    'expo-task-manager': { defineTask: (_name, run) => { callback = run; } },
    'expo-sqlite': { openDatabaseAsync: async () => ({ closeAsync: async () => { closed++; } }) },
    './coordinator': { syncGoogleTasks: async () => { throw new Error('SQLite busy'); } },
    '@/platform/storage/repository': { LOCAL_HOUSEHOLD_ID: 'home', initializeLocalDatabase: async () => {}, loadGoogleSyncState: async () => ({ enabled: true }) },
  });
  assert.equal(await callback({}), 'failed'); assert.equal(closed, 1);
});
