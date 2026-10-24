import assert from 'node:assert/strict';
import test from 'node:test';

import { calendarEntriesOnDate } from '../src/domain/calendar/day-entries.ts';
import { millisecondsUntilNextLocalDay, localDateFromISODateTime, localDateFromDate } from '../src/domain/scheduling/local-date.ts';

test('calendar day entries include adjacent-month dates independently of the displayed month', () => {
  const entries = [
    { id: 'october', windowStart: '2026-10-30', windowEnd: '2026-10-31' },
    { id: 'november', windowStart: '2026-11-01', windowEnd: '2026-11-03' },
  ];
  assert.deepEqual(calendarEntriesOnDate(entries, '2026-10-31').map((entry) => entry.id), ['october']);
  assert.deepEqual(calendarEntriesOnDate(entries, '2026-11-01').map((entry) => entry.id), ['november']);
  assert.deepEqual(calendarEntriesOnDate(entries, '2026-10-24'), []);
});

test('local-day refresh handles midnight and month/year boundaries', () => {
  assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 9, 24, 23, 59, 59, 500)), 500);
  assert.equal(millisecondsUntilNextLocalDay(new Date(2026, 11, 31, 23, 0)), 60 * 60 * 1000);
  const instant = '2026-10-24T16:00:00.000Z';
  assert.equal(localDateFromISODateTime(instant), localDateFromDate(new Date(instant)));
});
