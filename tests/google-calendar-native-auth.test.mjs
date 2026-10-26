import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/typescript-loader.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
const availability = await import('../src/features/google-sync/calendar-availability.ts');
const authorization = await import('../src/features/google-sync/calendar-authorization.ts');
const tasksScope = 'https://www.googleapis.com/auth/tasks';
const calendarScope = availability.GOOGLE_CALENDAR_FREEBUSY_SCOPE;

function harness(platform, { scopes = [tasksScope, calendarScope], cold = false, state = 'active', deny = false } = {}) {
  const events = []; let user = cold ? null : { scopes: [...scopes], user: { id: 'fixture-user' } };
  const sdk = {
    configure: async (options) => { events.push('configure'); assert.deepEqual(options.scopes, [tasksScope]); },
    getCurrentUser: () => user,
    signIn: async () => { events.push('restore'); user = { scopes: [...scopes], user: { id: 'fixture-user' } }; return { type: 'success', data: user }; },
    getTokens: async () => { events.push('tokens'); return { accessToken: 'fixture-access-token' }; },
    requestScopes: async (requested) => {
      events.push('consent'); assert.deepEqual(requested, [calendarScope]);
      if (deny) return {};
      user = { ...user, scopes: [...new Set([...user.scopes, ...requested])] };
      return { accessToken: 'fixture-access-token' };
    },
    createAccount: async () => assert.fail('noninteractive flow opened account creation'),
    presentExplicitSignIn: async () => assert.fail('noninteractive flow opened sign-in UI'),
  };
  const appState = { currentState: state };
  const gateway = loadNativeModule('src/platform/google-tasks/google-sign-in-gateway.ts', {
    'react-native': { Platform: { OS: platform }, AppState: appState },
    '@/features/google-sync/google-oauth-config': { getGoogleSyncOAuthConfig: () => ({ configured: true, webClientId: 'fixture-web', iosClientId: 'fixture-ios' }) },
    './google-tasks-api': { GOOGLE_TASKS_SCOPE: tasksScope },
    '@/features/google-sync/calendar-availability': availability,
    '@/features/google-sync/calendar-authorization': authorization,
    'react-native-nitro-google-signin': { GoogleOneTapSignIn: sdk, isSuccessResponse: (value) => value?.type === 'success' },
  });
  return { gateway, events, sdk, appState, setScopes: (next) => { user = { ...user, scopes: next }; } };
}

for (const platform of ['ios', 'android']) {
  for (const state of ['active', 'background', 'inactive']) {
    test(`${platform} ${state} Calendar token acquisition does not request consent or open interactive login`, async () => {
      const h = harness(platform, { state });
      assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
      assert.deepEqual(h.events, ['configure', 'tokens']);
    });
  }
  test(`${platform} Calendar incremental consent only adds freebusy and preserves Tasks`, async () => {
    const h = harness(platform, { scopes: [tasksScope] });
    await h.gateway.authorizeGoogleCalendarAvailability();
    await h.gateway.authorizeGoogleCalendarAvailability();
    assert.equal(h.events.filter((event) => event === 'consent').length, 1);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-access-token');
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
  });
  test(`${platform} denied Calendar consent retains Tasks and can be retried`, async () => {
    const h = harness(platform, { scopes: [tasksScope], deny: true });
    await assert.rejects(h.gateway.authorizeGoogleCalendarAvailability(), availability.CalendarPermissionRequiredError);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-access-token');
    assert.equal(await h.gateway.hasGoogleTasksSession(), true);
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(h.events.filter((event) => event === 'consent').length, 1);
  });
  for (const state of ['background', 'inactive']) {
    test(`${platform} ${state} cannot initiate Calendar permission UI`, async () => {
      const h = harness(platform, { scopes: [tasksScope], state });
      await assert.rejects(h.gateway.authorizeGoogleCalendarAvailability(), availability.CalendarPermissionRequiredError);
      assert.deepEqual(h.events, []);
    });
  }
  test(`${platform} missing Calendar scope never borrows the Tasks token`, async () => {
    const h = harness(platform, { scopes: [tasksScope] });
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(h.events.includes('tokens'), false);
  });
  test(`${platform} Calendar revocation during native token retrieval cannot be mistaken for a Calendar token`, async () => {
    const h = harness(platform);
    h.sdk.getTokens = async () => { h.setScopes([tasksScope]); return { accessToken: 'fixture-tasks-only' }; };
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
    assert.equal(await h.gateway.getGoogleTasksAccessToken(), 'fixture-tasks-only');
  });
  test(`${platform} 100 concurrent session checks configure the native SDK once`, async () => {
    const h = harness(platform);
    assert.ok((await Promise.all(Array.from({ length: 100 }, () => h.gateway.hasGoogleTasksSession()))).every(Boolean));
    assert.equal(h.events.filter((event) => event === 'configure').length, 1);
  });
  test(`${platform} native configuration failure is retried after the failed attempt settles`, async () => {
    const h = harness(platform); let attempts = 0;
    h.sdk.configure = async () => { if (++attempts === 1) throw new Error('fixture configure failure'); };
    await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), /fixture configure failure/u);
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token');
    assert.equal(attempts, 2);
  });
  test(`${platform} 100 simultaneous configuration failures share one attempt and allow a later retry`, async () => {
    const h = harness(platform); let attempts = 0;
    h.sdk.configure = async () => { if (++attempts === 1) throw new Error('fixture shared failure'); };
    const results = await Promise.allSettled(Array.from({ length: 100 }, () => h.gateway.getGoogleCalendarAccessToken()));
    assert.ok(results.every((result) => result.status === 'rejected')); assert.equal(attempts, 1);
    assert.equal(await h.gateway.getGoogleCalendarAccessToken(), 'fixture-access-token'); assert.equal(attempts, 2);
  });
}

test('iOS cold session restores Keychain once for 100 concurrent Calendar checks', async () => {
  const h = harness('ios', { cold: true });
  const results = await Promise.all(Array.from({ length: 100 }, () => h.gateway.getGoogleCalendarAccessToken()));
  assert.ok(results.every((token) => token === 'fixture-access-token'));
  assert.equal(h.events.filter((event) => event === 'restore').length, 1);
  assert.equal(h.events.includes('consent'), false);
});

test('Android missing saved session never attempts the potentially interactive signIn fallback', async () => {
  const h = harness('android', { cold: true });
  await assert.rejects(h.gateway.getGoogleCalendarAccessToken(), availability.CalendarPermissionRequiredError);
  await assert.rejects(h.gateway.getGoogleTasksAccessToken(), h.gateway.GoogleSignInRequiredError);
  assert.equal(h.events.includes('restore'), false);
  assert.equal(h.events.includes('consent'), false);
});
