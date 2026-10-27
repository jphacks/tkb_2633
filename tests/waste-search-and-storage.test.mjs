import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { searchWasteTypes } from '../src/features/waste/waste-types.ts';
import { createDatabase } from './helpers/sqlite.mjs';
const repository = await import('../src/platform/storage/repository.ts');

test('waste suggestions search Japanese readings immediately and normalize kana and gomi variants', () => {
  for (const query of ['かね', 'かねん', 'カネン', '可燃ゴミ', 'もえる']) assert.equal(searchWasteTypes(query)[0].label, '可燃ごみ', query);
  assert.equal(searchWasteTypes('びん')[0].label, 'びん');
  assert.equal(searchWasteTypes('かん')[0].label, '缶');
  for (const query of ['ふねん', 'しげん', 'ぺっと', 'ぷら', 'しんぶん', 'だんぼ', 'でんち', 'そだい']) assert.ok(searchWasteTypes(query).length, query);
  assert.deepEqual(searchWasteTypes(''), []);
  assert.deepEqual(searchWasteTypes('見つからない区分'), []);
  assert.ok(searchWasteTypes('ごみ').length > 20);
});

test('waste creation, edit, one-time hiding, restore and deletion persist without changing other weeks', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'qa-waste', label: '可燃ごみ', collectionWeekdays: [1, 1, 4] });
    let snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.deepEqual(snapshot.wasteSchedules.find((item) => item.id === 'qa-waste').collectionWeekdays, [1, 4]);
    const upcoming = snapshot.upcomingWasteDates.filter((item) => item.scheduleId === 'qa-waste');
    assert.ok(upcoming.length > 1);
    await repository.setWasteOccurrenceHidden(h.database, 'qa-waste', upcoming[0].date, true);
    snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.hiddenWasteDates.length, 1);
    assert.equal(snapshot.upcomingWasteDates.some((item) => item.date === upcoming[0].date), false);
    assert.equal(snapshot.upcomingWasteDates.some((item) => item.date === upcoming[1].date), true);
    await repository.setWasteOccurrenceHidden(h.database, 'qa-waste', upcoming[0].date, false);
    snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.hiddenWasteDates.length, 0);
    assert.equal(snapshot.upcomingWasteDates.length, upcoming.length);
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'qa-waste', label: '資源ごみ', collectionWeekdays: [2] });
    snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.wasteSchedules.length, 1);
    assert.equal(snapshot.wasteSchedules[0].label, '資源ごみ');
    await repository.deleteWeeklyWasteSchedule(h.database, 'qa-waste');
    snapshot = await repository.loadPlannerSnapshot(h.database);
    assert.equal(snapshot.wasteSchedules.length, 0);
  } finally { h.connection.close(); }
});

test('waste persistence rejects invalid weekdays, labels and nonexistent dates', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    for (const collectionWeekdays of [[], [0], [8], [1.5]]) await assert.rejects(repository.saveWeeklyWasteSchedule(h.database,
      { label: '可燃ごみ', collectionWeekdays }));
    await assert.rejects(repository.saveWeeklyWasteSchedule(h.database, { label: ' ', collectionWeekdays: [1] }));
    await assert.rejects(repository.setWasteOccurrenceHidden(h.database, 'qa', '2026-02-30', true));
  } finally { h.connection.close(); }
});

test('personal waste edits preserve newer untouched fields and never resurrect a deleted edited schedule', async () => {
  const h = createDatabase();
  try {
    await repository.initializeLocalDatabase(h.database);
    await repository.saveWeeklyWasteSchedule(h.database, { id: 'edited-waste', label: '可燃ごみ', collectionWeekdays: [2] });
    const displayed = (await repository.loadPlannerSnapshot(h.database)).wasteSchedules[0];
    await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, recurrence: 'monthly', monthlyDay: 28 });
    await repository.saveWeeklyWasteSchedule(h.database, { ...displayed, label: 'びん' }, displayed);
    const current = (await repository.loadPlannerSnapshot(h.database)).wasteSchedules[0];
    assert.equal(current.label, 'びん'); assert.equal(current.recurrence, 'monthly');
    await repository.deleteWeeklyWasteSchedule(h.database, displayed.id);
    await assert.rejects(repository.saveWeeklyWasteSchedule(h.database, displayed, displayed), /見つかりません/);
    assert.equal((await repository.loadPlannerSnapshot(h.database)).wasteSchedules.length, 0);
  } finally { h.connection.close(); }
});
