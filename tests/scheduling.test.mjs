import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateHouseworkSchedule, wouldCreateDependencyCycle } from '../src/domain/scheduling/engine.ts';
import { addDays, daysBetween } from '../src/domain/scheduling/local-date.ts';

const householdId = 'home';

function chore(id, overrides = {}) {
  return {
    id,
    householdId,
    name: id,
    category: 'テスト',
    description: '',
    enabled: true,
    frequencyDaysByMode: { frequent: 7, balanced: 7, relaxed: 7 },
    windowRadiusDays: 1,
    maxShiftDays: 4,
    load: 'normal',
    holidayPriority: false,
    everyday: false,
    instructions: [],
    tools: [],
    cautions: [],
    ...overrides,
  };
}

function input(overrides = {}) {
  return {
    householdId,
    from: '2026-10-24',
    through: '2026-12-31',
    today: '2026-10-24',
    chores: [],
    states: [],
    assignments: [],
    dependencies: [],
    completions: [],
    settings: {
      frequencyMode: 'balanced',
      restDays: [6, 7],
      loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 },
    },
    ...overrides,
  };
}

test('cycle and window are generated from the actual completion date', () => {
  const entries = generateHouseworkSchedule(input({
    chores: [chore('bath', { frequencyDaysByMode: { frequent: 3, balanced: 7, relaxed: 14 } })],
    states: [{ choreId: 'bath', lastCompletedDate: '2026-10-20', lastCompletedEstimated: false, initialPending: false }],
  }));

  assert.equal(entries[0].cycleBaseDate, '2026-10-27');
  assert.equal(entries[0].windowStart, '2026-10-26');
  assert.equal(entries[0].windowEnd, '2026-10-28');
});

test('frequency mode selects its cycle and a 30-day cycle gets the wider default window', () => {
  const entries = generateHouseworkSchedule(input({
    chores: [chore('monthly', {
      frequencyDaysByMode: { frequent: 14, balanced: 30, relaxed: 60 },
      windowRadiusDays: 2,
      maxShiftDays: 0,
    })],
    states: [{ choreId: 'monthly', lastCompletedDate: '2026-10-24', lastCompletedEstimated: false, initialPending: false }],
    settings: { ...input().settings, frequencyMode: 'balanced' },
  }));

  assert.equal(entries[0].cycleBaseDate, '2026-11-23');
  assert.equal(entries[0].windowStart, '2026-11-21');
  assert.equal(entries[0].windowEnd, '2026-11-25');
});

test('internal recommendation spreads chores inside a shared window before moving the window', () => {
  const chores = [chore('one', { load: 'normal' }), chore('two', { load: 'normal' })];
  const entries = generateHouseworkSchedule(input({
    chores,
    states: chores.map((item) => ({ choreId: item.id, lastCompletedDate: '2026-10-24', lastCompletedEstimated: false, initialPending: false })),
  }));
  const first = entries.find((entry) => entry.choreId === 'one');
  const second = entries.find((entry) => entry.choreId === 'two');

  assert.ok(first && second);
  assert.equal(first.windowStart, second.windowStart);
  assert.equal(first.windowEnd, second.windowEnd);
  assert.notEqual(first.suggestedDate, second.suggestedDate);
});

test('unknown first-run chores are distributed under daily load limits', () => {
  const chores = [
    chore('heavy-a', { load: 'heavy' }),
    chore('heavy-b', { load: 'heavy' }),
    chore('normal-a', { load: 'normal' }),
    chore('normal-b', { load: 'normal' }),
    chore('normal-c', { load: 'normal' }),
    chore('disabled', { enabled: false, load: 'heavy' }),
  ];
  const entries = generateHouseworkSchedule(input({
    chores,
    states: chores.map((item) => ({ choreId: item.id, initialPending: true, lastCompletedEstimated: false })),
  }));

  const initialEntries = entries.filter((entry) => entry.status === 'initialPending');
  assert.equal(initialEntries.length, 5);
  const byDate = new Map();
  for (const entry of initialEntries) {
    const load = byDate.get(entry.suggestedDate) ?? { heavy: 0, normal: 0 };
    const definition = chores.find((item) => item.id === entry.choreId);
    load[definition.load] += 1;
    byDate.set(entry.suggestedDate, load);
  }
  for (const load of byDate.values()) {
    assert.ok(load.heavy <= 1);
    assert.ok(load.normal <= 2);
  }
  assert.ok(new Set(initialEntries.filter((entry) => entry.choreId.startsWith('heavy')).map((entry) => entry.suggestedDate)).size === 2);
});

test('unknown first-run chores get recurring dates after their first planned occurrence', () => {
  const entries = generateHouseworkSchedule(input({
    through: '2026-11-20',
    chores: [chore('vacuum')],
    states: [{ choreId: 'vacuum', initialPending: true, lastCompletedEstimated: false }],
  }));

  assert.equal(entries.filter((entry) => entry.status === 'initialPending').length, 1);
  assert.ok(entries.some((entry) => entry.status === 'scheduled'));
  assert.ok(new Set(entries.map((entry) => entry.id)).size === entries.length);
});

test('an initial chore auto-advances after its three-day overdue grace period', () => {
  const entries = generateHouseworkSchedule(input({
    from: '2026-11-02',
    today: '2026-11-02',
    through: '2026-11-30',
    chores: [chore('vacuum')],
    states: [{
      choreId: 'vacuum',
      initialPending: true,
      initialScheduledDate: '2026-10-24',
      lastCompletedEstimated: false,
    }],
  }));
  const initial = entries.find((entry) => entry.id === 'vacuum:initial');
  const overdue = entries.find((entry) => entry.status === 'overdue');

  assert.equal(initial, undefined);
  assert.ok(overdue);
  assert.equal(overdue.cycleBaseDate, '2026-10-31');
  assert.equal(overdue.windowStart, '2026-10-30');
  assert.equal(overdue.windowEnd, '2026-11-01');
  assert.equal(overdue.status, 'overdue');
  assert.equal(overdue.overdueDays, 1);
  assert.ok(entries.some((entry) => entry.cycleBaseDate === '2026-11-07'));
});

test('an incomplete record never becomes a new completion-cycle base date', () => {
  const entries = generateHouseworkSchedule(input({
    chores: [chore('bath')],
    completions: [{ choreId: 'bath', outcome: 'incomplete', completedAt: '2026-10-23T12:00:00.000Z' }],
  }));

  assert.equal(entries[0].id, 'bath:initial');
  assert.equal(entries[0].status, 'initialPending');
});

test('overdue execution windows remain visible through day three and then auto-advance', () => {
  const chores = [chore('old')];
  const states = [{ choreId: 'old', lastCompletedDate: '2026-10-01', lastCompletedEstimated: false, initialPending: false }];
  for (const date of ['2026-10-24', '2026-10-25', '2026-10-26']) {
    const overdue = generateHouseworkSchedule(input({ chores, states, from: date, today: date }))
      .find((entry) => entry.status === 'overdue');
    assert.equal(overdue.id, 'old:2026-10-22');
    assert.equal(overdue.windowStart, '2026-10-21');
    assert.equal(overdue.windowEnd, '2026-10-23');
  }

  const afterGrace = generateHouseworkSchedule(input({ chores, states, from: '2026-10-27', today: '2026-10-27' }));
  assert.equal(afterGrace.some((entry) => entry.status === 'overdue'), false);
  assert.ok(afterGrace.some((entry) => entry.id === 'old:2026-10-29' && entry.status === 'scheduled'));
});

test('fixed first-run dates reserve capacity before another unknown chore is placed', () => {
  for (const reversed of [false, true]) {
  const chores = [chore('fixed', { load: 'heavy' }), chore('new', { load: 'heavy' })];
  const entries = generateHouseworkSchedule(input({
    chores: reversed ? chores.reverse() : chores,
    states: [
      { choreId: 'fixed', initialPending: true, initialScheduledDate: '2026-10-24', lastCompletedEstimated: false },
      { choreId: 'new', initialPending: true, lastCompletedEstimated: false },
    ],
  }));
  const initialDates = entries.filter((entry) => entry.id.endsWith(':initial')).map((entry) => entry.suggestedDate);
  assert.equal(new Set(initialDates).size, 2);
  }
});

test('holiday-priority windows include one of the configured rest days', () => {
  const entries = generateHouseworkSchedule(input({
    chores: [chore('deep-clean', {
      frequencyDaysByMode: { frequent: 4, balanced: 4, relaxed: 4 },
      windowRadiusDays: 0,
      maxShiftDays: 4,
      holidayPriority: true,
    })],
    states: [{ choreId: 'deep-clean', lastCompletedDate: '2026-10-24', lastCompletedEstimated: false, initialPending: false }],
    settings: { ...input().settings, restDays: [7] },
  }));

  assert.equal(entries[0].suggestedDate, '2026-10-25');
});

test('missed cycles remain one overdue entry and future cycles continue', () => {
  const entries = generateHouseworkSchedule(input({
    chores: [chore('air-filter')],
    states: [{ choreId: 'air-filter', lastCompletedDate: '2026-09-01', lastCompletedEstimated: false, initialPending: false }],
  }));

  const overdueEntries = entries.filter((entry) => entry.status === 'overdue');
  assert.equal(overdueEntries.length, 1);
  assert.equal(overdueEntries[0].overdueCycles, 7);
  assert.equal(overdueEntries[0].suggestedDate, '2026-10-20');
  assert.ok(entries.some((entry) => entry.status === 'scheduled' || entry.status === 'inWindow'));
});

test('dependency successors are not suggested before their predecessor', () => {
  const chores = [chore('after', { load: 'normal' }), chore('before', { load: 'normal' })];
  const entries = generateHouseworkSchedule(input({
    chores,
    states: chores.map((item) => ({ choreId: item.id, lastCompletedDate: '2026-10-24', lastCompletedEstimated: false, initialPending: false })),
    dependencies: [{ id: 'dep', predecessorChoreId: 'before', successorChoreId: 'after' }],
  }));
  const before = entries.find((entry) => entry.choreId === 'before');
  const after = entries.find((entry) => entry.choreId === 'after');

  assert.ok(before && after);
  assert.ok(after.suggestedDate >= before.suggestedDate);
});

test('dependency cycles are detected before schedule generation', () => {
  const dependencies = [
    { id: '1', predecessorChoreId: 'a', successorChoreId: 'b' },
    { id: '2', predecessorChoreId: 'b', successorChoreId: 'c' },
  ];
  assert.equal(wouldCreateDependencyCycle(dependencies, 'c', 'a'), true);
  assert.equal(wouldCreateDependencyCycle(dependencies, 'a', 'c'), false);
});

test('light chores keep a single-day period even when an older cached period was wider', () => {
  const date = '2026-10-23';
  const entries = generateHouseworkSchedule(input({
    chores: [chore('light', { load: 'light', windowRadiusDays: 2, maxShiftDays: 0 })],
    states: [{ choreId: 'light', lastCompletedDate: '2026-10-16', initialPending: false, lastCompletedEstimated: false }],
    previousScheduleEntries: [{ id: `light:${date}`, choreId: 'light', cycleBaseDate: date,
      windowStart: '2026-10-21', windowEnd: '2026-10-25', suggestedDate: date, status: 'inWindow', assignedMemberIds: [] }],
  }));
  assert.ok(entries.length > 0);
  assert.ok(entries.every((entry) => entry.windowStart === entry.suggestedDate && entry.windowEnd === entry.suggestedDate));
  assert.equal(entries[0].status, 'overdue');
});

test('load, cycle, frequency, holidays, and load limits preserve scheduling invariants in 72 configurations', () => {
  for (const load of ['light', 'normal', 'heavy']) {
    for (const cycle of [1, 2, 7, 30]) {
      for (const frequencyMode of ['frequent', 'balanced', 'relaxed']) {
        for (const restDays of [[], [6, 7]]) {
          const radius = load === 'light' ? 0 : load === 'normal' ? 1 : 2;
          const entries = generateHouseworkSchedule(input({
            through: '2026-11-30',
            chores: [chore('matrix', { load, windowRadiusDays: radius, holidayPriority: restDays.length > 0,
              frequencyDaysByMode: { frequent: cycle, balanced: cycle, relaxed: cycle } })],
            states: [{ choreId: 'matrix', lastCompletedDate: '2026-10-01', initialPending: false, lastCompletedEstimated: false }],
            settings: { frequencyMode, restDays, loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 1 } },
          }));
          assert.ok(entries.length > 0, `${load}/${cycle}/${frequencyMode}/${restDays}`);
          assert.equal(new Set(entries.map((entry) => entry.id)).size, entries.length);
          for (const entry of entries) {
            assert.ok(entry.windowStart <= entry.suggestedDate && entry.suggestedDate <= entry.windowEnd);
            assert.equal(daysBetween(entry.windowStart, entry.windowEnd), radius * 2);
            if (entry.status === 'overdue') assert.ok(input().today <= addDays(entry.windowEnd, 3));
          }
        }
      }
    }
  }
});
