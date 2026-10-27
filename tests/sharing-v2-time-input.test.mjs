import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { v2LocalTimeChoices, v2LocalTimeInput, v2TargetFromForm, v2TargetFormValues, v2RuleSelectorFromForm } from '../src/features/sharing/v2-ui/target-form.ts';
import { materializeRuleTarget } from '../src/features/sharing/v2/rule-target.ts';
import { v2WallTimeCandidates } from '../src/features/sharing/v2/local-time.ts';

test('v2 local time input requires an explicit occurrence of a repeated clock hour instead of silently recording the earlier one on either OS timezone', () => {
  const previous = process.env.TZ;
  try {
    for (const host of ['Asia/Tokyo', 'Pacific/Honolulu', 'America/New_York']) {
      process.env.TZ = host;
      const choices = v2LocalTimeChoices('2026-11-01', '01:30', 'America/New_York');
      assert.deepEqual(choices.map((entry) => entry.value), ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z']);
      assert.deepEqual(choices.map((entry) => entry.label), ['1回目（UTC-04:00）', '2回目（UTC-05:00）']);
      assert.throws(() => v2LocalTimeInput('2026-11-01', '01:30', 'America/New_York'), /どの時刻か/);
      for (const choice of choices) assert.equal(v2LocalTimeInput('2026-11-01', '01:30', 'America/New_York', choice.value), choice.value);
      assert.throws(() => v2LocalTimeInput('2026-11-01', '01:30', 'America/New_York', '2026-11-01T07:30:00.000Z'), /選び直して/);
      assert.throws(() => v2LocalTimeInput('2026-03-08', '02:30', 'America/New_York'), /存在しない/);
      assert.equal(v2LocalTimeInput('2026-10-28', '13:15', 'Asia/Kathmandu'), '2026-10-28T07:30:00.000Z');
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});

test('v2 repeated time choices include half-hour transitions and validate a fixed interval using each explicitly selected clock occurrence', () => {
  assert.deepEqual(v2LocalTimeChoices('2026-04-05', '01:45', 'Australia/Lord_Howe').map((entry) => entry.value),
    ['2026-04-04T14:45:00.000Z', '2026-04-04T15:15:00.000Z']);
  const input = { mode: 'fixed', day: '2026-11-01', clock: '01:30', endDay: '2026-11-01', endClock: '01:45', timeZone: 'America/New_York' };
  assert.throws(() => v2TargetFromForm(input), /どの時刻か/);
  assert.deepEqual(v2TargetFromForm({ ...input, clockChoice: '2026-11-01T06:30:00.000Z', endClockChoice: '2026-11-01T06:45:00.000Z' }),
    { precision: 'interval', start: '2026-11-01T06:30:00.000Z', end: '2026-11-01T06:45:00.000Z' });
  assert.throws(() => v2TargetFromForm({ ...input, clockChoice: '2026-11-01T06:30:00.000Z', endClockChoice: '2026-11-01T05:45:00.000Z' }));
});

test('v2 manual-date form scopes keep the selected common anchor and inclusive period without inventing an interval or shifting another round', () => {
  const round = { id: 'stable-round', anchorDate: '2026-10-27' };
  assert.deepEqual(v2RuleSelectorFromForm('once', round, ''), { scope: 'once', occurrenceId: 'stable-round', anchorDate: '2026-10-27' });
  assert.deepEqual(v2RuleSelectorFromForm('twoWeeks', round, ''), { scope: 'period', range: { from: '2026-10-27', through: '2026-11-09' } });
  assert.deepEqual(v2RuleSelectorFromForm('oneMonth', round, ''), { scope: 'period', range: { from: '2026-10-27', through: '2026-11-26' } });
  assert.deepEqual(v2RuleSelectorFromForm('ongoing', round, ''), { scope: 'ongoing', from: '2026-10-27' });
  assert.throws(() => v2RuleSelectorFromForm('endDate', round, '2026-10-26'));
  assert.deepEqual(v2TargetFormValues({ precision: 'date', date: '2026-10-27' }, 'Asia/Tokyo'), { day: '2026-10-27', clock: '', endDay: '2026-10-27', endClock: '' });
  assert.deepEqual(v2TargetFormValues({ precision: 'interval', start: '2026-10-27T10:00:00.000Z', end: '2026-10-27T10:30:00.000Z' }, 'Asia/Tokyo'),
    { day: '2026-10-27', clock: '19:00', endDay: '2026-10-27', endClock: '19:30' });
});

test('v2 repeating clock rules preserve the explicitly chosen reference instant including the second repeated hour and request review for a future ambiguous hour', () => {
  const base = { id: 'clock-rule', choreId: 'chore', subjectUserId: null, selector: { scope: 'ongoing', from: '2026-10-25' }, referenceAnchorDate: '2026-11-01',
    timeZoneAtCreation: 'America/New_York', mode: 'fixed', strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'owner', ruleVersion: 1,
    target: { precision: 'interval', start: '2026-11-01T06:30:27.123Z', end: '2026-11-01T06:45:27.123Z' } };
  const occurrence = (anchorDate) => ({ id: anchorDate, choreId: 'chore', anchorDate, windowStart: anchorDate, windowEnd: anchorDate, ruleVersion: 1 });
  assert.deepEqual(materializeRuleTarget(base, occurrence('2026-11-01'), 'America/New_York'), { kind: 'target', target: base.target });
  assert.deepEqual(materializeRuleTarget(base, occurrence('2026-11-08'), 'America/New_York'), { kind: 'target', target: {
    precision: 'interval', start: '2026-11-08T06:30:27.123Z', end: '2026-11-08T06:45:27.123Z' } });
  const earlier = { ...base, referenceAnchorDate: '2026-10-25', target: { precision: 'interval', start: '2026-10-25T05:30:00.000Z', end: '2026-10-25T05:45:00.000Z' } };
  assert.deepEqual(materializeRuleTarget(earlier, occurrence('2026-11-01'), 'America/New_York'), { kind: 'review', reason: 'ambiguousTime' });
  const spring = { ...base, referenceAnchorDate: '2026-03-01', mode: 'deadline', target: { precision: 'instant', at: '2026-03-01T07:30:00.000Z' } };
  assert.deepEqual(materializeRuleTarget(spring, occurrence('2026-03-08'), 'America/New_York'), { kind: 'review', reason: 'invalidInterval' });
});

test('v2 pinned wall-clock candidates round-trip exact milliseconds and never manufacture a local time inside a gap', () => {
  for (const timeZone of ['Asia/Tokyo', 'America/New_York', 'Australia/Lord_Howe', 'Asia/Kathmandu', 'Europe/Berlin']) {
    const values = v2WallTimeCandidates({ date: '2026-10-28', hour: 12, minute: 23, second: 45, millisecond: 678, timeZone });
    assert.equal(values.length, 1); assert.equal(new Date(values[0]).getUTCMilliseconds(), 678);
  }
  assert.deepEqual(v2WallTimeCandidates({ date: '2026-03-08', hour: 2, minute: 30, timeZone: 'America/New_York' }), []);
  assert.equal(v2WallTimeCandidates({ date: '2026-04-05', hour: 1, minute: 45, timeZone: 'Australia/Lord_Howe' }).length, 2);
  assert.throws(() => v2WallTimeCandidates({ date: '2026-10-28', hour: 24, minute: 0, timeZone: 'Asia/Tokyo' }));
});
