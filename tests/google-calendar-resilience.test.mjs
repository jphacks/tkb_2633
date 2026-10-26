import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/typescript-loader.mjs';

const { refreshCalendarWithDependencies } = await import('../src/features/google-sync/calendar-coordinator.ts');
const { createCalendarFreeBusyClient } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { createCalendarQueryRange, shouldRefreshCalendar } = await import('../src/features/google-sync/calendar-availability.ts');
const { classifyGoogleSyncFailure } = await import('../src/features/google-sync/error-classification.ts');
const now = new Date('2026-10-26T00:00:00.000Z');
const stamp = now.toISOString();
const range = createCalendarQueryRange('2026-10-26', '2027-04-24', 'Asia/Tokyo');

function harness({ status = 'idle', enabled = true, freshCoverage = true } = {}) {
  let state = { householdId: 'home', enabled, status, retryCount: 0, lastSuccessfulSyncAt: stamp, lastAttemptAt: stamp,
    nextRetryAt: new Date(now.getTime() + 3600_000).toISOString(), updatedAt: stamp };
  let days = [{ localDate: range.from, busyMinutes: 200, timeZone: range.timeZone, fetchedAt: stamp }];
  let calls = 0; let commits = 0;
  const port = {
    loadState: async () => ({ ...state }), saveState: async (value) => { state = { ...value }; },
    hasFreshCoverage: async () => freshCoverage,
    getAccessToken: async () => 'fixture-token', client: { query: async () => { calls++; return []; } },
    commitSuccess: async (value, next) => { commits++; days = value; state = { ...next }; },
    readPlanningSignatures: async () => ({ current: 'same', applied: 'same' }), regeneratePlanner: async () => false,
  };
  return { port, state: () => state, days: () => days, calls: () => calls, commits: () => commits,
    refresh: (options = {}) => refreshCalendarWithDependencies(port, { range, now, ...options }) };
}

for (const label of ['time-zone changed', 'next local day has uncovered horizon', 'cache is missing']) {
  test(`Calendar refreshes ${label} even within the normal 24-hour interval`, async () => {
    const h = harness({ freshCoverage: false });
    assert.equal((await h.refresh()).kind, 'success'); assert.equal(h.calls(), 1); assert.equal(h.commits(), 1);
  });
}

for (const status of ['syncing', 'retryPending', 'permissionRequired', 'error']) {
  test(`missing Calendar coverage respects ${status} instead of bypassing its gate`, async () => {
    const h = harness({ status, freshCoverage: false });
    assert.equal((await h.refresh()).kind, 'skipped'); assert.equal(h.calls(), 0);
  });
}

test('Calendar OFF performs zero transport, token, signature or planner operations even when forced', async () => {
  const h = harness({ enabled: false, freshCoverage: false });
  for (const name of ['getAccessToken', 'hasFreshCoverage', 'readPlanningSignatures', 'regeneratePlanner']) {
    h.port[name] = async () => { assert.fail(`disabled Calendar invoked ${name}`); };
  }
  assert.equal((await h.refresh({ force: true })).kind, 'disabled'); assert.equal(h.calls(), 0);
});

for (const status of ['idle', 'syncing', 'retryPending']) {
  test(`Calendar ${status} recovers an invalid or missing persisted timestamp`, () => {
    const key = status === 'idle' ? 'lastSuccessfulSyncAt' : status === 'syncing' ? 'lastAttemptAt' : 'nextRetryAt';
    for (const value of [undefined, '', 'invalid-date']) {
      assert.equal(shouldRefreshCalendar({ enabled: true, status, [key]: value }, now), true, `${key}=${value}`);
    }
  });
}

for (const code of ['NO_ACTIVITY', 'IN_PROGRESS']) {
  test(`Calendar native ${code} is transient and preserves granted permission`, async () => {
    const h = harness();
    h.port.getAccessToken = async () => { throw Object.assign(new Error('fixture native availability'), { code }); };
    assert.equal((await h.refresh({ force: true })).kind, 'retryPending');
    assert.equal(h.state().lastErrorCode, 'calendar_native_operation_unavailable');
    assert.equal(h.calls(), 0); assert.equal(h.state().enabled, true);
  });
}

for (const status of [401, 403, 429, 500, 502, 503]) for (const failureAt of [1, 2, 3]) {
  test(`Calendar chunk ${failureAt} HTTP ${status} never commits partial 181-day coverage`, async () => {
    const h = harness(); let requests = 0; const previous = structuredClone(h.days());
    h.port.client = createCalendarFreeBusyClient(async () => {
      requests++;
      return requests === failureAt ? new Response('{}', { status }) : Response.json({ calendars: { primary: { busy: [] } } });
    });
    await h.refresh({ force: true });
    assert.equal(requests, failureAt); assert.equal(h.commits(), 0); assert.deepEqual(h.days(), previous);
    assert.equal(h.state().lastSuccessfulSyncAt, stamp);
    assert.equal(h.state().status, status === 401 ? 'permissionRequired' : status === 403 ? 'error' : 'retryPending');
  });
}

test('FreeBusy timeout aborts its transport and preserves the old cache without starting later chunks', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const h = harness(); let requests = 0;
  h.port.client = createCalendarFreeBusyClient(async (_url, options) => {
    requests++;
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('fixture timeout', 'AbortError')), { once: true }));
  });
  const pending = h.refresh({ force: true }); await new Promise(setImmediate);
  t.mock.timers.tick(20_000);
  assert.equal((await pending).kind, 'retryPending'); assert.equal(requests, 1); assert.equal(h.commits(), 0);
});

test('Retry-After malformed and huge values always produce a serializable finite retry time (1000 headers)', () => {
  const headers = ['1e309', '1e308', '99999999999999999999999999999999999', '-1', 'invalid', '', '0', '7200'];
  for (let index = 0; index < 992; index++) headers.push(`${index}e${index}`);
  for (const retryAfter of headers) {
    const result = classifyGoogleSyncFailure({ status: 429, retryAfter }, now);
    assert.equal(result.kind, 'retry');
    assert.ok(Number.isFinite(result.nextRetryAt.getTime()), retryAfter);
    assert.ok(result.nextRetryAt.getTime() >= now.getTime() + 3600_000);
    assert.doesNotThrow(() => result.nextRetryAt.toISOString());
  }
});
