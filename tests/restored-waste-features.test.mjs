import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createDatabase } from './helpers/sqlite.mjs';
import * as scheduler from '../src/features/waste/weekly-scheduler.ts';
import { wasteCalendarLabels } from '../src/features/waste/calendar-labels.ts';

const repository = await import('../src/platform/storage/repository.ts');

const schedules = [
  { id: 'weekly', label: '可燃ごみ', collectionWeekdays: [2], recurrence: 'weekly' },
  { id: 'biweekly', label: 'びん', collectionWeekdays: [4], recurrence: 'biweekly', anchorDate: '2026-10-29' },
  { id: 'monthly', label: '粗大ごみ', collectionWeekdays: [], recurrence: 'monthly', monthlyDay: 31 },
];

test('restored waste capability: weekly, biweekly and monthly calculation', () => {
  assert.equal(typeof scheduler.generateWasteCollectionDates, 'function', 'all recurrence modes must remain available');
  const dates = (index, from, through) => scheduler.generateWasteCollectionDates({ ...schedules[index], householdId: 'home' }, from, through).map((item) => item.date);
  assert.deepEqual(dates(1, '2026-10-01', '2026-11-30'), ['2026-10-29', '2026-11-12', '2026-11-26']);
  assert.deepEqual(dates(2, '2026-01-01', '2026-03-31'), ['2026-01-31', '2026-02-28', '2026-03-31']);
});

test('restored waste capability: onboarding saves every recurrence atomically', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.completeFirstSetup(h.database, {
      frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null,
      wasteSchedules: schedules,
    });
    const snapshot = await repository.loadPlannerSnapshot(h.database, '2026-10-26');
    assert.equal(snapshot.settings.setupCompleted, true);
    assert.equal(snapshot.wasteSchedules.length, 3, 'onboarding must not silently discard waste schedules');
    for (const expected of schedules) {
      const stored = snapshot.wasteSchedules.find((item) => item.id === expected.id);
      assert.equal(stored.recurrence, expected.recurrence);
      assert.equal(stored.anchorDate, expected.anchorDate);
      assert.equal(stored.monthlyDay, expected.monthlyDay);
    }
  } finally { h.connection.close(); }
});

test('restored waste capability: weekday headers, date labels, month-end and hidden exceptions stay distinct', () => {
  const definitions = schedules.map((schedule) => ({ ...schedule, householdId: 'home' }));
  const labels = wasteCalendarLabels(definitions, '2026-10-25', '2026-11-30', ['biweekly:2026-11-12']);
  assert.deepEqual(labels.weeklyByColumn[2], ['可燃ごみ']);
  assert.equal(labels.byDate.has('2026-10-27'), false, 'weekly labels belong only to headers');
  assert.deepEqual(labels.byDate.get('2026-10-29'), ['びん']);
  assert.equal(labels.byDate.has('2026-11-05'), false, 'biweekly collection must not become weekly');
  assert.equal(labels.byDate.has('2026-11-12'), false, 'one-time hiding applies to the displayed month too');
  assert.deepEqual(labels.byDate.get('2026-11-30'), ['粗大ごみ']);
  const leap = scheduler.generateWasteCollectionDates({ ...definitions[2], monthlyDay: 30 }, '2028-02-01', '2028-03-31');
  assert.deepEqual(leap.map((item) => item.date), ['2028-02-29', '2028-03-30']);
});

test('invalid recurrence setup rolls back setup completion and all schedules', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    for (const invalid of [
      { ...schedules[1], anchorDate: '2026-02-30' }, { ...schedules[1], anchorDate: undefined },
      { ...schedules[1], collectionWeekdays: [1, 4] }, { ...schedules[1], collectionWeekdays: [1] },
      { ...schedules[2], monthlyDay: 0 }, { ...schedules[2], monthlyDay: 32 }, { ...schedules[2], monthlyDay: 2.5 },
      { ...schedules[0], recurrence: 'yearly' },
    ]) {
      await assert.rejects(repository.completeFirstSetup(h.database, {
        frequencyMode: 'balanced', restDays: [], enabledChoreIds: [], previousDates: {}, weatherLocation: null,
        wasteSchedules: [schedules[0], invalid],
      }));
      assert.equal(h.connection.prepare('SELECT setup_completed FROM household_settings').get().setup_completed, 0);
      assert.equal(h.connection.prepare('SELECT COUNT(*) AS n FROM weekly_waste_schedules').get().n, 0);
    }
  } finally { h.connection.close(); }
});

test('editing weekly to monthly retains id and far-future hidden exception, and reloading retains recurrence', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveWeeklyWasteSchedule(h.database, schedules[0]);
    await repository.saveWeeklyWasteSchedule(h.database, { ...schedules[2], id: 'weekly' });
    await repository.setWasteOccurrenceHidden(h.database, 'weekly', '2027-02-28', true);
    const snapshot = await repository.loadPlannerSnapshot(h.database, '2026-10-26');
    assert.equal(snapshot.wasteSchedules.length, 1);
    assert.equal(snapshot.wasteSchedules[0].recurrence, 'monthly');
    assert.ok(snapshot.hiddenWasteOccurrenceKeys.includes('weekly:2027-02-28'));
    assert.equal(wasteCalendarLabels(snapshot.wasteSchedules, '2027-02-01', '2027-02-28', snapshot.hiddenWasteOccurrenceKeys).byDate.size, 0);
  } finally { h.connection.close(); }
});
