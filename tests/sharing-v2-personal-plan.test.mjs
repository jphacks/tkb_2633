import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, anchorDate, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } };
const now = Date.parse('2026-10-27T10:00:00Z');
const binding = { ownerUserId: 'a', accountGeneration: 'account-1', mainDeviceId: 'main-device', mainRevision: 1, calendarBinding: 'google-1' };
const cache = (extra = {}) => ({ ...binding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-27T09:59:00Z', coverage: { start: '2026-10-26T15:00:00Z', end: '2026-11-27T15:00:00Z' },
  intervals: [{ start: '2026-10-27T00:00:00Z', end: '2026-10-27T10:00:00Z' }], ...extra });
const input = (extra = {}) => ({ viewerUserId: 'a', settings, now, ...extra });
const first = (plan) => plan.recommendations.find((entry) => entry.occurrenceId === v2OccurrenceId('v2-plan-test', 'floor', anchorDate));

test('v2 personal recommendations differ by private Calendar while the common windows and common hash remain identical', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'], before: 0 }); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const common = f.plan(); const before = JSON.stringify(common);
  const busy = buildV2PersonalPlan(common, input({ calendar: { cache: cache(), binding } }));
  const free = buildV2PersonalPlan(common, input({ calendar: { cache: cache({ intervals: [] }), binding } }));
  assert.equal(first(busy).date, '2026-10-28'); assert.equal(first(free).date, anchorDate);
  assert.equal(busy.commonPlanHash, free.commonPlanHash); assert.equal(JSON.stringify(common), before);
  assert.equal(JSON.stringify(busy).includes('google-1'), false); assert.equal(JSON.stringify(busy).includes('intervals'), false);
});
test('v2 personal recommendations keep shared manual days fixed, retain overload warnings and mark Calendar freshness unknown', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); f.designation(date(anchorDate));
  const common = f.plan(); const result = buildV2PersonalPlan(common, input({ calendar: { cache: cache({ fetchedAt: '2026-10-26T00:00:00Z' }), binding },
    privateLoad: { ownerUserId: 'a', days: { [anchorDate]: { heavy: 0, normal: 3, total: 3 } } } }));
  const entry = first(result); assert.equal(entry.date, anchorDate); assert.equal(entry.state, 'manual');
  assert.equal(entry.calendar.kind, 'unknown'); assert.ok(entry.reasons.includes('calendarUnconfirmed')); assert.ok(entry.reasons.includes('dailyLoadExceeded'));
});
test('v2 personal recommendations cannot read another UID private preferences or use its Calendar as a free result', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); const common = f.plan();
  assert.throws(() => buildV2PersonalPlan(common, input({ privateLoad: { ownerUserId: 'b', days: {} } })), /本人以外/);
  const wrong = buildV2PersonalPlan(common, input({ calendar: { cache: cache(), binding: { ...binding, ownerUserId: 'b' } } }));
  assert.equal(first(wrong).calendar.kind, 'unknown'); assert.equal(first(wrong).calendar.reason, 'binding');
  assert.throws(() => buildV2PersonalPlan(common, input({ viewerUserId: 'stranger' })), /参加状態/);
});
test('v2 personal recommendations do not query Calendar or move shared work assigned only to another person', async () => {
  const f = await fixture({ preset: 'assigned', members: ['b'], before: 0 }); const common = f.plan();
  const result = buildV2PersonalPlan(common, input({ calendar: { cache: cache(), binding } }));
  for (const entry of result.recommendations) { assert.equal(entry.state, 'otherAssignee'); assert.equal(entry.reasons.includes('personalRecommendation'), false); }
});
test('v2 personal recommendations preserve fixed intervals even during private Calendar conflicts and never expose busy intervals', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  f.designation({ precision: 'interval', start: '2026-10-27T01:00:00Z', end: '2026-10-27T02:00:00Z' });
  const common = f.plan(); const result = buildV2PersonalPlan(common, input({ calendar: { cache: cache(), binding } }));
  const entry = first(result); assert.equal(entry.state, 'manual'); assert.equal(entry.date, anchorDate); assert.equal(entry.calendar.kind, 'conflict');
  assert.ok(entry.reasons.includes('calendarConflict')); assert.equal(common.occurrences[0].subjects[0].formalDate.target.start, '2026-10-27T01:00:00.000Z');
});
