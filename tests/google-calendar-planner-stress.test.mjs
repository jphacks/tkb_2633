import assert from 'node:assert/strict';
import test from 'node:test';
import './helpers/typescript-loader.mjs';
const { generateHouseworkSchedule } = await import('../src/domain/scheduling/engine.ts');
const { dependencyPredecessorForDate } = await import('../src/domain/scheduling/dependency-matching.ts');
const { addDays, daysBetween } = await import('../src/domain/scheduling/local-date.ts');
const { LaundryWeatherAdjustmentPolicy, applyLaundryWeatherAdjustments, isSuitableLaundryDay } = await import('../src/features/weather/laundry-policy.ts');
const today = '2026-10-26';

function fixture(frequencyMode, restDays) {
  const chores = Array.from({ length: 21 }, (_, index) => {
    const cycle = index < 4 ? 1 : index === 4 ? 30 : index === 5 ? 7 : [2, 7, 14, 30, 60][index % 5];
    return { id: `volume-${index}`, householdId: 'home', name: `家事 ${index}`, category: index === 5 ? '洗濯' : '掃除',
      enabled: true, everyday: index < 4, load: index < 4 ? 'light' : ['light', 'normal', 'heavy'][index % 3],
      holidayPriority: index > 3 && index % 2 === 0, laundryDryingPreference: index === 5 ? 'outdoors' : undefined,
      frequencyDaysByMode: { frequent: index < 4 ? 1 : Math.max(2, Math.floor(cycle / 2)), balanced: cycle, relaxed: index < 4 ? 1 : cycle * 2 },
      windowRadiusDays: index < 4 ? 0 : 1, maxShiftDays: 2 };
  });
  return { householdId: 'home', from: today, through: addDays(today, 180), today, chores,
    states: chores.map(({ id }) => ({ choreId: id, lastCompletedDate: '2026-10-25', initialPending: false })),
    assignments: [], completions: [], dependencies: [{ predecessorChoreId: 'volume-4', successorChoreId: 'volume-5' }],
    settings: { frequencyMode, restDays, loadLimits: { heavyDailyLimit: 4, normalDailyLimit: 10 } } };
}

for (const frequencyMode of ['frequent', 'balanced', 'relaxed']) for (const restDays of [[], [6, 7], [2, 4], [1, 2, 3, 4, 5, 6, 7]]) {
  test(`Calendar preserves 21-chore 181-day plans: ${frequencyMode} rest=${restDays.join(',')} (32 patterns)`, () => {
    const input = fixture(frequencyMode, restDays); const baseline = generateHouseworkSchedule(input);
    const expectedIds = baseline.map(({ id }) => id).sort(); const byId = new Map(input.chores.map((chore) => [chore.id, chore]));
    assert.ok(baseline.length > 724);
    if (frequencyMode !== 'relaxed') assert.ok(baseline.length > 1000);
    const distinctPatterns = new Set();
    for (let seed = 0; seed < 32; seed++) {
      let noise = Math.imul(seed + 1, 0x9e3779b1) >>> 0;
      const availability = Object.fromEntries(Array.from({ length: 181 }, (_, offset) => {
        noise = (Math.imul(noise, 1664525) + 1013904223) >>> 0;
        return [addDays(today, offset), { busyMinutes: seed === 0 ? 0 : seed === 1 ? 1440 : [0, 120, 121, 300, 301, 480, 481, 1440][noise >>> 29] }];
      }));
      distinctPatterns.add(JSON.stringify(availability));
      const result = generateHouseworkSchedule({ ...input, previousScheduleEntries: baseline, externalAvailabilityByDate: availability });
      assert.deepEqual(result.map(({ id }) => id).sort(), expectedIds, `seed=${seed}`);
      assert.equal(new Set(result.map(({ id }) => id)).size, result.length);
      if (seed === 0) assert.deepEqual(result, baseline);
      const entriesByChore = new Map(input.chores.map((chore) => [chore.id, result.filter(({ choreId }) => choreId === chore.id)]));
      for (let index = 0; index < 4; index++) {
        const daily = entriesByChore.get(`volume-${index}`);
        assert.equal(daily.length, 181);
        assert.equal(new Set(daily.map(({ suggestedDate }) => suggestedDate)).size, 181);
        assert.ok(daily.every((entry) => entry.suggestedDate === entry.cycleBaseDate && entry.windowStart === entry.windowEnd));
      }
      for (const entry of result) {
        const chore = byId.get(entry.choreId);
        assert.ok(Math.abs(daysBetween(entry.cycleBaseDate, entry.suggestedDate)) <= chore.windowRadiusDays + chore.maxShiftDays);
        assert.ok(entry.suggestedDate >= entry.windowStart && entry.suggestedDate <= entry.windowEnd);
        if (entry.choreId === 'volume-5') {
          const predecessor = dependencyPredecessorForDate(entriesByChore.get('volume-4'), entry.cycleBaseDate);
          if (predecessor) assert.ok(entry.suggestedDate >= predecessor.suggestedDate);
        }
      }
      const forecast = Array.from({ length: 7 }, (_, offset) => ({ date: addDays(today, offset),
        weatherCode: (seed + offset) % 3 ? 0 : 61, precipitationProbability: (seed + offset) % 3 ? 0 : 90,
        precipitationMm: (seed + offset) % 3 ? 0 : 10 }));
      const policy = new LaundryWeatherAdjustmentPolicy({ ...input, externalAvailabilityByDate: availability });
      const adjustments = policy.proposeAdjustments({ forecast, schedule: result });
      const adjusted = applyLaundryWeatherAdjustments(result, adjustments);
      assert.deepEqual(adjusted.map(({ id }) => id).sort(), expectedIds);
      for (const change of adjustments) assert.ok(isSuitableLaundryDay(forecast.find(({ date }) => date === change.data.suggestedDate)));
    }
    assert.equal(distinctPatterns.size, 32);
  });
}
