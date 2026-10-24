import assert from 'node:assert/strict';
import test from 'node:test';

import { splitWasteOccurrencesByVisibility, wasteOccurrenceKey } from '../src/features/waste/occurrence-visibility.ts';
import { generateWeeklyCollectionDates } from '../src/features/waste/weekly-scheduler.ts';

const schedule = { id: 'waste-burnable', householdId: 'home', label: '可燃ごみ', collectionWeekdays: [1] };
const nextWeek = { id: 'waste-recycle', householdId: 'home', label: '資源ごみ', collectionWeekdays: [1] };

test('hiding a waste occurrence affects only its schedule id and date, and restoring shows it again', () => {
  const dates = [
    ...generateWeeklyCollectionDates(schedule, '2026-10-26', '2026-11-02'),
    ...generateWeeklyCollectionDates(nextWeek, '2026-10-26', '2026-11-02'),
  ];
  assert.equal(dates.length, 4);
  const hiddenKey = wasteOccurrenceKey({ scheduleId: schedule.id, date: '2026-10-26' });
  const hidden = splitWasteOccurrencesByVisibility(dates, new Set([hiddenKey]));
  assert.equal(hidden.hidden.length, 1);
  assert.equal(hidden.hidden[0].label, '可燃ごみ');
  assert.equal(hidden.hidden[0].date, '2026-10-26');
  assert.equal(hidden.visible.length, 3);
  assert.equal(hidden.visible.some((item) => item.scheduleId === schedule.id && item.date === '2026-11-02'), true);
  assert.equal(hidden.visible.some((item) => item.scheduleId === nextWeek.id && item.date === '2026-10-26'), true);

  const restored = splitWasteOccurrencesByVisibility(dates, new Set());
  assert.equal(restored.hidden.length, 0);
  assert.equal(restored.visible.length, 4);
});
