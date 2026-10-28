import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { proposePrivatePlannerRelocation } from '../src/features/sharing/private-planner/relocation.ts';
const hour = 3600_000; const day = Date.parse('2026-10-26T00:00:00Z'); const owner = 'private-relocation-owner';
function input() { return { groupKind: 'family', fromGroupAdmin: true, personConsented: false, automatic: true, manuallyFixed: false, completed: false,
  original: { start: day + 9 * hour, end: day + 10 * hour }, sharedFixed: { start: day + 9 * hour, end: day + 10 * hour },
  windowStart: '2026-10-26', windowEnd: '2026-10-26', timeZone: 'UTC', fixedAndBusyIntervals: [], calendarConfirmed: true, now: day }; }
function preferences() { return { schemaVersion: 1, ownerUserId: owner, revision: 1, timeZone: 'UTC', restDays: [],
  loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [{ weekday: 1, startMinute: 8 * 60, endMinute: 12 * 60 }] }; }

test('private saved time bands authorize only their own owner and preserve fixed completed and unconfigured chores', () => {
  assert.equal(proposePrivatePlannerRelocation(owner, preferences(), input()).kind, 'moved');
  assert.throws(() => proposePrivatePlannerRelocation('another-owner', preferences(), input()), /本人/u);
  assert.deepEqual(proposePrivatePlannerRelocation(owner, null, input()), { kind: 'needsReview', reason: 'missingAllowedTimes' });
  for (const patch of [{ manuallyFixed: true }, { completed: true }, { automatic: false }]) {
    assert.equal(proposePrivatePlannerRelocation(owner, null, { ...input(), ...patch }).kind, 'protected');
    assert.equal(proposePrivatePlannerRelocation(owner, preferences(), { ...input(), ...patch }).kind, 'protected');
  }
  assert.equal(proposePrivatePlannerRelocation(owner, preferences(), { ...input(), groupKind: 'roommates' }).kind, 'requiresConsent');
});

test('private saved bands use their own region without moving the original chore window to that region', () => {
  const own = { ...preferences(), timeZone: 'Asia/Tokyo', allowedBands: [{ weekday: 2, startMinute: 7 * 60, endMinute: 8 * 60 }] };
  const original = { start: day + 20 * hour, end: day + 21 * hour }; const before = structuredClone(own);
  const result = proposePrivatePlannerRelocation(owner, own, { ...input(), original, sharedFixed: original });
  assert.deepEqual(result, { kind: 'moved', original, proposed: { start: day + 22 * hour, end: day + 23 * hour }, reason: 'sharedFixedConflict' });
  assert.deepEqual(own, before);
});

test('private saved bands keep unknown Calendar and ambiguous DST time boundaries out of automatic proposals', () => {
  assert.equal(proposePrivatePlannerRelocation(owner, preferences(), { ...input(), calendarConfirmed: false }).reason, 'unconfirmedCalendar');
  const date = '2026-11-01'; const base = Date.parse(date + 'T00:00:00Z');
  const own = { ...preferences(), timeZone: 'America/New_York', allowedBands: [{ weekday: 7, startMinute: 90, endMinute: 180 }] };
  const original = { start: base + 7 * hour, end: base + 8 * hour };
  assert.deepEqual(proposePrivatePlannerRelocation(owner, own, { ...input(), original, sharedFixed: original,
    windowStart: date, windowEnd: date, timeZone: own.timeZone, now: base }), { kind: 'needsReview', reason: 'ambiguousAllowedTimes' });
});
