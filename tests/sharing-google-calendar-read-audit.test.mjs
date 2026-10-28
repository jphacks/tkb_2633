import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { screenHarness } from './helpers/screen-harness.mjs';
import { loadNativeModule } from './helpers/native-module.mjs';
const { createGoogleCalendarReadAudit } = await import('../src/features/sharing/development/google-calendar-read-audit.ts');

function fixture() {
  const state = { development: true, subject: 'synthetic-google-owner', checks: 0, queries: 0, restores: 0, consents: 0 };
  const port = { development: () => state.development, now: () => Date.parse('2026-10-28T00:00:00.000Z'), timeZone: () => 'Asia/Tokyo',
    currentAccount: async () => { state.checks++; return state.subject ? { subject: state.subject, label: 'Never export this label' } : null; },
    restoreAccount: async () => { state.restores++; state.subject = 'synthetic-google-owner'; }, authorize: async () => { state.consents++; },
    query: async (subject, range) => { assert.equal(subject, state.subject); assert.equal(range.from, '2026-10-28'); assert.equal(range.through, '2027-04-26'); state.queries++;
      return { requests: 3, intervals: [{ start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T01:00:00.000Z' }] }; } };
  return { state, port, audit: createGoogleCalendarReadAudit(port) };
}

test('Google read-only audit starts no authentication or acquisition on construction and exports only bounded aggregate results', async () => {
  const f = fixture(); assert.equal(f.state.checks, 0); assert.equal(f.state.queries, 0); await assert.rejects(() => f.audit.read(), /ログイン/u);
  assert.deepEqual(await f.audit.checkAccount(), { ready: true }); assert.deepEqual(await f.audit.read(), { days: 181, requests: 3, intervals: 1 });
  assert.equal(f.state.consents, 0); assert.equal(f.state.restores, 0);
});

test('Google read-only audit coalesces one hundred requests and refuses account changes without returning private intervals', async () => {
  const f = fixture(); await f.audit.checkAccount(); let release; let enter; const gate = new Promise(done => { release = done; }); const entered = new Promise(done => { enter = done; }); const original = f.port.query;
  f.port.query = async (...args) => { enter(); await gate; return original(...args); };
  const calls = Array.from({ length: 100 }, () => f.audit.read()); await entered; assert.equal(new Set(calls).size, 1); release(); await Promise.all(calls); assert.equal(f.state.queries, 1);
  f.port.query = async (...args) => { const response = await original(...args); f.state.subject = 'different-google-owner'; return response; };
  await assert.rejects(() => f.audit.read(), /アカウントが変わりました/u);
});

test('Google read-only audit keeps restore and scope consent explicit and blocks every operation in release', async () => {
  const f = fixture(); f.state.subject = null; assert.deepEqual(await f.audit.checkAccount(), { ready: false }); assert.equal(f.state.restores, 0);
  await assert.rejects(() => f.audit.authorize(), /ログイン/u); assert.deepEqual(await f.audit.restoreAccount(), { ready: true }); assert.equal(f.state.restores, 1); assert.equal(f.state.consents, 0);
  await f.audit.authorize(); assert.equal(f.state.consents, 1); f.state.development = false; assert.throws(() => f.audit.read(), /開発/u);
  await assert.rejects(() => f.audit.checkAccount(), /開発/u); await assert.rejects(() => f.audit.restoreAccount(), /開発/u); await assert.rejects(() => f.audit.authorize(), /開発/u);
});

test('Google read-only audit reuses capture interval validation and cannot report a malformed partial response as a successful empty Calendar', async () => {
  const f = fixture(); await f.audit.checkAccount();
  for (const result of [{ requests: 0, intervals: [] }, { requests: 3, intervals: [{ start: '2026-10-28', end: '2026-10-29' }] },
    { requests: 3, intervals: [{ start: '2026-10-28T00:00:00.000Z', end: '2026-10-28T01:00:00.000Z', summary: 'must not be copied' }] }]) {
    f.port.query = async () => result; await assert.rejects(() => f.audit.read());
  }
});

for (const platform of ['ios', 'android']) {
  test(`${platform} real Google read audit UI requires explicit session check and read and shows no Google label subject token or busy interval`, async () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = true; const f = fixture(); let mount;
    try {
      const screen = screenHarness('src/app/development/google-calendar-read-preview.tsx', { platform, effect: callback => { mount ??= callback; }, mocks: {
        '../../platform/sharing/google-calendar-read-audit': { openGoogleCalendarReadAudit: () => f.audit },
      } }); const cleanup = mount(); assert.equal(f.state.checks, 0); assert.equal(f.state.queries, 0);
      await screen.press('この端末のGoogleログインを確認'); assert.equal(f.state.queries, 0); assert.match(screen.text(), /Googleログインを確認済み/u);
      await screen.press('実Googleの181日分を読取検査'); assert.match(screen.text(), /実Google Calendar読取 PASS：181日・3通信・1区間/u);
      for (const text of ['Never export', 'synthetic-google-owner', '2026-10-28', 'accessToken']) assert.equal(screen.text().includes(text), false); cleanup();
    } finally { globalThis.__DEV__ = previous; }
  });
  test(`${platform} real Google read audit shows only allowlisted failure codes and never requests scopes automatically`, async () => {
    const previous = globalThis.__DEV__; globalThis.__DEV__ = true; const f = fixture(); let mount;
    f.port.query = async () => { const error = new Error('do-not-render private-label ya29.synthetic-secret'); error.name = 'CalendarPermissionRequiredError'; throw error; };
    try {
      const screen = screenHarness('src/app/development/google-calendar-read-preview.tsx', { platform, effect: callback => { mount ??= callback; }, mocks: {
        '../../platform/sharing/google-calendar-read-audit': { openGoogleCalendarReadAudit: () => f.audit },
      } }); const cleanup = mount(); await screen.press('この端末のGoogleログインを確認'); await screen.press('実Googleの181日分を読取検査');
      assert.match(screen.text(), /検査コード：CalendarPermissionRequiredError/u); assert.equal(screen.text().includes('ya29.'), false); assert.equal(screen.text().includes('private-label'), false);
      assert.equal(f.state.consents, 0); await screen.press('明示して時間帯の読取権限を確認'); assert.equal(f.state.consents, 1); cleanup();
    } finally { globalThis.__DEV__ = previous; }
  });
}

test('real Google audit route cannot compose a Native source in release', () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = false;
  try { const screen = screenHarness('src/app/development/google-calendar-read-preview.tsx', { mocks: {
    '../../platform/sharing/google-calendar-read-audit': { openGoogleCalendarReadAudit: () => { throw new Error('must not open'); } },
  } }); assert.match(screen.text(), /開発ビルド専用/u); assert.equal(screen.nodes().some(node => node.props.accessibilityRole === 'button'), false); }
  finally { globalThis.__DEV__ = previous; }
});

test('real Google Native read audit composes only the existing Google gateways and reports transport counts without Firebase or storage', async () => {
  const previous = globalThis.__DEV__; globalThis.__DEV__ = true; let port; let tokenRequests = 0; let queries = 0;
  const module = loadNativeModule('src/platform/sharing/google-calendar-read-audit.ts', {
    '../../features/sharing/development/google-calendar-read-audit': { createGoogleCalendarReadAudit: value => { port = value; return value; } },
    '../../features/google-sync/calendar-availability': { getDeviceTimeZone: () => 'Asia/Tokyo' }, '../../features/google-sync/operation-lock': { withGoogleSyncOperation: work => work() },
    '../google-tasks/google-calendar-freebusy-client': { createCalendarFreeBusyClient: (_fetch, counted) => ({ query: async (token, _range, options) => { assert.equal(token, 'synthetic-token'); assert.deepEqual(options, { timeoutMs: 20000, maxIntervals: 100000 }); counted(); counted(); counted(); queries++; return []; } }) },
    '../google-tasks/google-sign-in-gateway': { getCurrentGoogleCalendarAccount: async () => ({ subject: 'own', label: 'private-label' }), restorePrivateGoogleCalendarAccount: async () => ({}),
      authorizePrivateGoogleCalendarSource: async () => {}, getGoogleCalendarAccessToken: async subject => { assert.equal(subject, 'own'); tokenRequests++; return 'synthetic-token'; }, getCurrentGoogleSubject: async () => 'own' },
    '../../features/google-sync/account-binding': { GoogleAccountMismatchError: class extends Error {} },
  });
  try { module.openGoogleCalendarReadAudit(); assert.equal(tokenRequests, 0); assert.deepEqual(await port.query('own', {}), { intervals: [], requests: 3 }); assert.equal(tokenRequests, 1); assert.equal(queries, 1);
    globalThis.__DEV__ = false; assert.throws(() => module.openGoogleCalendarReadAudit(), /開発/u); }
  finally { globalThis.__DEV__ = previous; }
});
