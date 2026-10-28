import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { googleFixture } from './helpers/sharing-v2-google.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
import * as storeModule from '../src/platform/storage/sharing-v2-google-tasks.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
const runtimeModule = await import('../src/features/sharing/v2/google-tasks-runtime.ts');

test('Native v2 Tasks remains unconfigured without OAuth, then uses the same owner-only input and existing Google gateway', async () => {
  const h = await googleFixture(); const calls = [];
  try {
    const module = loadNativeModule('src/platform/sharing/v2-google-tasks.ts', {
      'expo-crypto': { randomUUID: () => 'native-google-completion' }, '../storage/sharing-v2-google-tasks': storeModule,
      '../../features/sharing/v2/google-tasks-runtime': runtimeModule,
      '../google-tasks/google-tasks-api': { createGoogleTasksApi: () => h.api },
      '../google-tasks/google-sign-in-gateway': { getCurrentGoogleSubject: async () => 'synthetic-google-subject',
        getGoogleTasksAccessToken: async subject => { assert.equal(subject, 'synthetic-google-subject'); calls.push('token'); return 'synthetic-token'; },
        authorizeGoogleTasks: async () => { calls.push('authorize'); }, restorePrivateGoogleCalendarAccount: async () => { calls.push('restore'); return { subject: 'synthetic-google-subject', label: '検査用' }; } },
      './v2-local-planning': { readV2LocalPlanning: async (input, now) => { assert.equal(input.userId, 'owner'); calls.push('private-input'); return { revision: 'input-v1',
        personalize: plan => buildV2PersonalPlan(plan, { viewerUserId: input.userId, now: now.getTime(), settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } } }) }; } },
    });
    const runtime = module.createNativeV2GoogleTasks(h.scope);
    await runtime.synchronize(); assert.deepEqual(calls, []); assert.equal(h.tasks.size, 0);
    await runtime.connect(await runtime.reviewConnection()); assert.deepEqual(calls, ['restore', 'authorize']);
    assert.equal((await runtime.synchronize({ force: true })).kind, 'success'); assert.deepEqual(calls, ['restore', 'authorize', 'private-input', 'token']);
    assert.ok(h.tasks.size > 0); assert.equal(h.d.connection.prepare('SELECT COUNT(*) AS n FROM households').get().n, 0);
    h.stop(); await assert.rejects(runtime.synchronize({ force: true }), /account changed/u); assert.equal(calls.filter(call => call === 'token').length, 1);
  } finally { h.close(); }
});

test('Native v2 Tasks QA service rejects release calls before identity, database or Google initialization', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try {
    const source = readFileSync(new URL('../src/platform/sharing/v2-google-tasks-preview.ts', import.meta.url), 'utf8');
    const mocks = Object.fromEntries([...source.matchAll(/from ['"]([^'"]+)['"]/gu)].map(match => [match[1], {}]));
    const module = loadNativeModule('src/platform/sharing/v2-google-tasks-preview.ts', mocks);
    await assert.rejects(module.createV2GoogleTasksPreview(), /開発ビルド専用/u);
  } finally { if (previous === undefined) delete globalThis.__DEV__; else globalThis.__DEV__ = previous; }
});
