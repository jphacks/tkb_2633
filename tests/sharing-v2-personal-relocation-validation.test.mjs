import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { proposePersonalRelocation } from '../src/features/sharing/v2/personal-relocation.ts';
const hour = 3600_000; const day = Date.parse('2026-10-26T00:00:00Z');
function input() { return { groupKind: 'family', fromGroupAdmin: true, personConsented: false, automatic: true, manuallyFixed: false, completed: false,
  original: { start: day + 9 * hour, end: day + 10 * hour }, sharedFixed: { start: day + 7 * hour, end: day + 11 * hour },
  windowStart: '2026-10-26', windowEnd: '2026-10-26', timeZone: 'UTC', allowedWindows: [{ start: day + 6 * hour, end: day + 18 * hour }],
  fixedAndBusyIntervals: [], calendarConfirmed: true, now: day }; }

test('private relocation rejects reversed zero-length nonfinite and out-of-range original intervals rather than returning an invalid move', () => {
  for (const original of [{ start: day + 9 * hour, end: day + 8 * hour }, { start: day, end: day },
    { start: NaN, end: day + hour }, { start: day, end: Infinity }, { start: day, end: 9e15 }]) assert.throws(() => proposePersonalRelocation({ ...input(), original }));
});
test('private relocation rejects unknown group kinds and string-valued authority flags before automatic movement', () => {
  for (const patch of [{ groupKind: 'unknown' }, { fromGroupAdmin: 'true' }, { personConsented: 'false' }, { automatic: 'false' },
    { manuallyFixed: 'false' }, { completed: 'false' }, { calendarConfirmed: 'true' }]) assert.throws(() => proposePersonalRelocation({ ...input(), ...patch }));
});
test('private relocation rejects malformed fixed intervals and cannot carry unrelated payload fields into movement history', () => {
  for (const sharedFixed of [{ start: day, end: day }, { start: NaN, end: day + hour }]) assert.throws(() => proposePersonalRelocation({ ...input(), sharedFixed }));
  assert.throws(() => proposePersonalRelocation({ ...input(), original: { ...input().original, accessToken: 'never-record-this' } }));
});
