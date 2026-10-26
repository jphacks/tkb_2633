import assert from 'node:assert/strict';
import { test } from 'node:test';
import { generateHouseworkSchedule } from '../src/domain/scheduling/engine.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
import { LaundryWeatherAdjustmentPolicy } from '../src/features/weather/laundry-policy.ts';
import { dependencyPredecessorForDate } from '../src/domain/scheduling/dependency-matching.ts';

const today = '2026-10-26';
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 10 } };
const dependency = { id: 'a-before-b', predecessorChoreId: 'a', successorChoreId: 'b' };
function chore(id, cycle, extra = {}) {
  return { id, householdId: 'home', name: id, category: 'テスト', description: '', enabled: true,
    frequencyDaysByMode: { frequent: cycle, balanced: cycle, relaxed: cycle }, windowRadiusDays: 0, maxShiftDays: 0,
    load: 'light', holidayPriority: false, everyday: cycle === 1, instructions: [], tools: [], cautions: [], ...extra };
}
function schedule(predecessorCycle, successorCycle, extra = {}) {
  const chores = [chore('b', successorCycle), chore('a', predecessorCycle)];
  return generateHouseworkSchedule({ householdId: 'home', today, from: today, through: '2026-12-31', chores,
    states: chores.map(({ id }) => ({ choreId: id, lastCompletedDate: '2026-10-25', initialPending: false, lastCompletedEstimated: false })),
    assignments: [], dependencies: [dependency], completions: [], settings, ...extra });
}
function entry(choreId, base, suggested = base, status = 'scheduled') {
  return { id: `${choreId}:${base}`, householdId: 'home', choreId, cycleBaseDate: base,
    suggestedDate: suggested, windowStart: base, windowEnd: suggested, status, assignedMemberIds: [] };
}
function forecast(sunny) {
  return Array.from({ length: 7 }, (_, i) => { const date = addDays(today, i); return { date,
    precipitationProbability: date === sunny ? 0 : 90, precipitationMm: date === sunny ? 0 : 10,
    weatherCode: date === sunny ? 0 : 61 }; });
}

test('a daily successor of a monthly predecessor retains every due date after their last completion', () => {
  const rows = schedule(30, 1).filter(({ choreId }) => choreId === 'b');
  assert.equal(rows[0]?.cycleBaseDate, today);
  assert.equal(rows.length, 67);
  assert.deepEqual(rows.map(({ cycleBaseDate }) => cycleBaseDate), Array.from({ length: 67 }, (_, i) => addDays(today, i)));
});

test('dependency date matching retains all occurrences for 25 different cycle pairs', () => {
  for (const a of [1, 2, 7, 14, 30]) for (const b of [1, 2, 7, 14, 30]) {
    const expected = [];
    for (let day = addDays('2026-10-25', b); day <= '2026-12-31'; day = addDays(day, b)) expected.push(day);
    const actual = schedule(a, b).filter(({ choreId }) => choreId === 'b').map(({ cycleBaseDate }) => cycleBaseDate);
    assert.deepEqual(actual, expected, `predecessor=${a}, successor=${b}`);
  }
});

test('the first same-cycle successor follows the first predecessor rather than the second', () => {
  const rows = schedule(7, 7);
  assert.equal(rows.find(({ choreId }) => choreId === 'b')?.cycleBaseDate, '2026-11-01');
});

test('unknown first predecessors remain required even before their first cycle date', () => {
  const initial = { ...entry('a', '2026-10-28', '2026-10-28', 'initialPending'), id: 'a:initial' };
  assert.equal(dependencyPredecessorForDate([initial, entry('a', '2026-11-27')], today), initial);
  const rows = schedule(30, 7, {
    chores: [chore('a', 30), chore('b', 7, { maxShiftDays: 4 })],
    states: [{ choreId: 'a', initialPending: true, initialScheduledDate: '2026-10-28' }, { choreId: 'b', initialPending: true }],
  });
  assert.equal(rows.find(({ choreId }) => choreId === 'b')?.suggestedDate, '2026-10-28');
});

test('shifted predecessor dates do not change cycle binding and all bound successors constrain weather', () => {
  const older = entry('a', '2026-10-26', '2026-10-28');
  const later = entry('a', '2026-10-30');
  assert.equal(dependencyPredecessorForDate([later, older], '2026-10-27'), older);
  const chores = [chore('a', 30, { category: '洗濯', laundryDryingPreference: 'outdoors', maxShiftDays: 4 }), chore('b', 1)];
  const policy = new LaundryWeatherAdjustmentPolicy({ today, chores, completions: [], dependencies: [dependency], settings });
  const rows = [older, entry('b', '2026-10-27', '2026-10-28'), entry('b', '2026-10-28', '2026-10-30')];
  assert.deepEqual(policy.proposeAdjustments({ forecast: forecast('2026-10-29'), schedule: rows }), []);
});

test('multiple predecessors and a dependency chain retain daily successors without future-cycle constraints', () => {
  const chores = [chore('c', 1), chore('b', 7), chore('a', 30)];
  const rows = schedule(30, 7, { chores,
    states: chores.map(({ id }) => ({ choreId: id, lastCompletedDate: '2026-10-25', initialPending: false })),
    dependencies: [dependency, { predecessorChoreId: 'a', successorChoreId: 'c' }, { predecessorChoreId: 'b', successorChoreId: 'c' }],
  });
  assert.equal(rows.filter(({ choreId }) => choreId === 'c').length, 67);
});

test('weather can move a successor before the next unrelated monthly predecessor cycle', () => {
  const chores = [chore('a', 30), chore('b', 2, { category: '洗濯', laundryDryingPreference: 'outdoors', maxShiftDays: 1 })];
  const rows = [entry('a', '2026-11-24'), entry('b', today), entry('b', '2026-10-28')];
  const policy = new LaundryWeatherAdjustmentPolicy({ today, chores, completions: [], dependencies: [dependency], settings });
  const changes = policy.proposeAdjustments({ forecast: forecast('2026-10-27'), schedule: rows });
  assert.equal(changes.find(({ scheduleEntryId }) => scheduleEntryId === `b:${today}`)?.data.suggestedDate, '2026-10-27');
});

test('weather constrains a predecessor only against successors bound to its cycle', () => {
  const chores = [chore('a', 30, { category: '洗濯', laundryDryingPreference: 'outdoors', maxShiftDays: 2 }), chore('b', 1)];
  const rows = [entry('a', '2026-10-29'), entry('a', '2026-11-28'), entry('b', today), entry('b', '2026-10-29', '2026-10-31')];
  const policy = new LaundryWeatherAdjustmentPolicy({ today, chores, completions: [], dependencies: [dependency], settings });
  const changes = policy.proposeAdjustments({ forecast: forecast('2026-10-30'), schedule: rows });
  assert.equal(changes.find(({ scheduleEntryId }) => scheduleEntryId === 'a:2026-10-29')?.data.suggestedDate, '2026-10-30');
});
