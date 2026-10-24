import assert from 'node:assert/strict';
import { test } from 'node:test';

import { generateHouseworkSchedule, wouldCreateDependencyCycle } from '../src/domain/scheduling/engine.ts';

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
    load: 'light',
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

test('an incomplete first-run date stays fixed and records overdue cycles', () => {
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

  assert.ok(initial);
  assert.equal(initial.suggestedDate, '2026-10-24');
  assert.equal(initial.status, 'overdue');
  assert.equal(initial.overdueCycles, 2);
  assert.ok(entries.some((entry) => entry.cycleBaseDate === '2026-11-07'));
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

  assert.equal(entries.filter((entry) => entry.status === 'overdue').length, 1);
  assert.equal(entries[0].overdueCycles, 7);
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
