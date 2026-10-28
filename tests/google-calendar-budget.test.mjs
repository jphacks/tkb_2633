import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
const { createCalendarFreeBusyClient } = await import('../src/platform/google-tasks/google-calendar-freebusy-client.ts');
const { createCalendarQueryRange } = await import('../src/features/google-sync/calendar-availability.ts');
const range = createCalendarQueryRange('2026-10-28', '2027-04-26', 'UTC');

test('FreeBusy optional total budget spans chunk boundaries and rejects a late partial result without starting a third request', async t => {
  let now = Date.parse('2026-10-28T00:00:00.000Z'); t.mock.method(Date, 'now', () => now); let calls = 0;
  const client = createCalendarFreeBusyClient(async () => { calls++; now += 12_000; return Response.json({ calendars: { primary: { busy: [] } } }); });
  await assert.rejects(() => client.query('synthetic-token', range, { timeoutMs: 20_000 }), error => error.code === 'calendar_timeout');
  assert.equal(calls, 2);
});
test('FreeBusy optional total budget aborts the actual active transport and never proceeds with incomplete coverage', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let calls = 0; let signal;
  const client = createCalendarFreeBusyClient(async (_url, options) => { calls++; signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true })); });
  const pending = client.query('synthetic-token', range, { timeoutMs: 37 }); const rejected = assert.rejects(() => pending, error => error.code === 'calendar_timeout');
  await new Promise(setImmediate); t.mock.timers.tick(37); await rejected; assert.equal(signal.aborted, true); assert.equal(calls, 1);
});
test('FreeBusy optional interval bound covers all chunks together and rejects an oversized response instead of returning partial data', async () => {
  let calls = 0;
  const client = createCalendarFreeBusyClient(async (_url, options) => { calls++; const window = JSON.parse(options.body); const start = Date.parse(window.timeMin);
    return Response.json({ calendars: { primary: { busy: Array.from({ length: 2 }, (_, index) => ({ start: new Date(start + index * 120_000).toISOString(), end: new Date(start + index * 120_000 + 60_000).toISOString() })) } } }); });
  await assert.rejects(() => client.query('synthetic-token', range, { maxIntervals: 3 }), error => error.code === 'calendar_response_too_large'); assert.equal(calls, 2);
});
test('FreeBusy refuses invalid optional budgets and bounds before any HTTP request', async () => {
  let calls = 0; const client = createCalendarFreeBusyClient(async () => { calls++; return Response.json({ calendars: { primary: { busy: [] } } }); });
  for (const options of [{ timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: Infinity }, { timeoutMs: 120_001 },
    { maxIntervals: 0 }, { maxIntervals: NaN }, { maxIntervals: 1.5 }, { maxIntervals: 1_000_001 }]) {
    await assert.rejects(() => client.query('synthetic-token', range, options), error => error.code === 'calendar_invalid_query_options');
  }
  assert.equal(calls, 0);
});

test('FreeBusy total timeout still aborts the active request after the wall clock moves backwards', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let now = 100_000; t.mock.method(Date, 'now', () => now); let calls = 0; let signal;
  const client = createCalendarFreeBusyClient(async (_url, options) => { calls++; signal = options.signal;
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('synthetic abort', 'AbortError')), { once: true })); });
  const pending = client.query('synthetic-token', range, { timeoutMs: 37 }); const rejected = assert.rejects(() => pending, error => error.code === 'calendar_timeout');
  await new Promise(setImmediate); now = 1_000; t.mock.timers.tick(37); await rejected; assert.equal(signal.aborted, true); assert.equal(calls, 1);
});

test('FreeBusy external cancellation aborts the actual active request and prevents later chunks', async () => {
  const external = new AbortController(); let calls = 0; let started;
  const entered = new Promise(done => { started = done; });
  const client = createCalendarFreeBusyClient(async (_url, options) => { calls++; started();
    return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('synthetic external cancel', 'AbortError')), { once: true })); });
  const pending = client.query('synthetic-token', range, { signal: external.signal }); const rejected = assert.rejects(() => pending, error => error.code === 'calendar_timeout');
  await entered; external.abort(); await rejected; assert.equal(calls, 1);
});
test('FreeBusy already cancelled external requests never start an HTTP request', async () => {
  const external = new AbortController(); external.abort(); let calls = 0;
  const client = createCalendarFreeBusyClient(async () => { calls++; throw new Error('must not send'); });
  await assert.rejects(() => client.query('synthetic-token', range, { signal: external.signal }), error => error.code === 'calendar_timeout'); assert.equal(calls, 0);
});
