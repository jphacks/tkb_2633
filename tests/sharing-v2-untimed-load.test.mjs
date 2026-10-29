import './helpers/typescript-loader.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, anchorDate, date } from './helpers/sharing-v2-plan-fixture.mjs';
import { assessV2UntimedDailyLoad, v2DailyLoadMessage } from '../src/features/sharing/v2/daily-load.ts';
import { createPrivateCalendarReader } from '../src/features/sharing/v2/private-availability.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { privateFixture } from './helpers/sharing-v2-private-fixture.mjs';
import { projectV2PrivateTasks } from '../src/features/sharing/v2-ui/private-overlay.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';
const { readPersonalPlannerOverlaySnapshot } = await import('../src/platform/storage/repository.ts');

const limits = { heavyDailyLimit: 1, normalDailyLimit: 3 };
const overlay = (daily = {}, extra = {}) => ({ status: 'ready', ownerUserId: 'a', today: anchorDate, timeZone: 'Asia/Tokyo', dailyLoad: daily, ...extra });
const assess = (f, extra = {}) => assessV2UntimedDailyLoad({ model: { viewerUserId: 'a', plan: f.plan() }, userId: 'a', limits, ...extra });
const freeze = (value) => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };

test('untimed daily load warns at the configured limit without inventing a time conflict or moving any chore', async () => {
  const f = await fixture(); const model = freeze({ viewerUserId: 'a', plan: f.plan() });
  const privateOverlay = freeze(overlay({ [anchorDate]: { heavy: 1, normal: 2, total: 5 } }));
  const before = JSON.stringify({ model, privateOverlay });
  const result = assessV2UntimedDailyLoad({ model, privateOverlay, userId: 'a', limits });
  assert.deepEqual(result.scopes[0].load, { heavy: 1, normal: 3, total: 6 });
  assert.deepEqual(result.scopes[0].reached, ['heavy', 'normal']); assert.deepEqual(result.scopes[0].exceeded, []);
  assert.equal(result.timeConflict, 'excluded'); assert.equal(result.relocation, 'excluded');
  assert.equal(JSON.stringify({ model, privateOverlay }), before);
  assert.match(v2DailyLoadMessage(result), /重い家事1件／上限1件、普通の家事3件／上限3件/u);
  assert.ok(!JSON.stringify(result).includes('床を掃除する')); assert.ok(!JSON.stringify(result).includes('T10:'));
  const exceeded = assess(f, { privateOverlay: overlay({ [anchorDate]: { heavy: 2, normal: 3, total: 5 } }) });
  assert.deepEqual(exceeded.scopes[0].exceeded, ['heavy', 'normal']);
  assert.equal(v2DailyLoadMessage(assess(f)), null);
});

test('untimed load counts only this member’s pending work and removes completed disabled or differently assigned chores', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] });
  assert.equal(assess(f).scopes[0].load.normal, 1);
  const done = f.complete({ actor: 'a' }); assert.equal(assess(f).scopes[0].load.total, 0);
  f.make('completion', { targetOperationId: done.operationId }, { actor: 'a', entityId: done.entityId, operationType: 'undo' });
  assert.equal(assess(f).scopes[0].load.total, 1);
  f.make('chore', { enabled: false }, { entityId: 'floor' }); assert.equal(assess(f).scopes[0].load.total, 0);
  const other = await fixture({ preset: 'assigned', members: ['b'] }); assert.equal(assess(other).scopes[0].load.total, 0);
  const each = await fixture({ preset: 'eachMember' }); each.complete({ actor: 'b', subject: 'b' });
  assert.equal(assess(each).scopes[0].load.total, 1);
});

test('untimed load combines matching civil days but preserves personal dates and separate loads across timezones', async () => {
  const f = await fixture();
  const result = assess(f, { privateOverlay: overlay({ '2026-10-26': { heavy: 2, normal: 0, total: 2 } }, { today: '2026-10-26', timeZone: 'America/Los_Angeles' }) });
  assert.deepEqual(result.scopes.map(scope => [scope.source, scope.date, scope.timeZone, scope.load]), [
    ['shared', anchorDate, 'Asia/Tokyo', { heavy: 0, normal: 1, total: 1 }],
    ['personal', '2026-10-26', 'America/Los_Angeles', { heavy: 2, normal: 0, total: 2 }],
  ]);
  assert.match(v2DailyLoadMessage(result), /2026-10-26（個人・America\/Los_Angeles）/u);
  assert.equal(result.scopes[0].reached.length, 0);
});

test('untimed load never treats unavailable personal data as confirmed free or reads another member’s data', async () => {
  const f = await fixture(); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const result = assess(f, { privateOverlay: { status: 'unavailable' } });
  assert.equal(result.privateStatus, 'unavailable'); assert.equal(result.scopes[0].source, 'shared'); assert.match(v2DailyLoadMessage(result), /重い家事1件/u);
  assert.throws(() => assess(f, { privateOverlay: overlay({}, { ownerUserId: 'b' }) }), /本人以外/u);
  assert.throws(() => assess(f, { userId: 'b' }), /本人/u);
  for (const value of [{ heavy: -1, normal: 0, total: 0 }, { heavy: 1, normal: 2, total: 1 }, { heavy: 0, normal: NaN, total: 1 }]) {
    assert.throws(() => assess(f, { privateOverlay: overlay({ [anchorDate]: value }) }), /負荷/u);
  }
  for (const bad of [{ heavyDailyLimit: 0, normalDailyLimit: 3 }, { heavyDailyLimit: 1, normalDailyLimit: Infinity }]) assert.throws(() => assess(f, { limits: bad }), /上限/u);
});

test('date-only manual work checks load even when Calendar is missing without becoming an interval or requesting a time', async () => {
  const f = await fixture({ preset: 'assigned', members: ['a'] }); f.designation(date(anchorDate));
  const plan = f.plan(); const personal = buildV2PersonalPlan(plan, { viewerUserId: 'a', settings: { frequencyMode: 'balanced', restDays: [], loadLimits: limits }, now: Date.parse('2026-10-27T01:00:00Z') });
  const before = JSON.stringify({ plan, personal });
  const result = assessV2UntimedDailyLoad({ model: { viewerUserId: 'a', plan }, personal, userId: 'a', limits,
    privateOverlay: overlay({ [anchorDate]: { heavy: 0, normal: 2, total: 2 } }) });
  assert.deepEqual(result.scopes[0].reached, ['normal']); assert.equal(result.scopes[0].untimed, 3);
  assert.equal(JSON.stringify({ plan, personal }), before);
  const reader = createPrivateCalendarReader(null, {}, 0);
  assert.notEqual(reader(date(anchorDate)).kind, 'conflict');
  assert.ok(!JSON.stringify(result).includes('start')); assert.ok(!JSON.stringify(result).includes('calendarConflict'));
});

test('fixed-time shared work alone does not create an untimed alert while light tasks have no invented heavy or normal quota', async () => {
  const f = await fixture(); f.designation({ precision: 'interval', start: '2026-10-27T01:00:00Z', end: '2026-10-27T02:00:00Z' });
  const fixed = assess(f, { limits: { heavyDailyLimit: 1, normalDailyLimit: 1 } });
  assert.equal(fixed.scopes[0].untimed, 0); assert.equal(v2DailyLoadMessage(fixed), null);
  f.make('chore', { load: 'light' }, { entityId: 'floor' });
  const light = assess(f, { privateOverlay: overlay({ [anchorDate]: { heavy: 0, normal: 0, total: 100 } }) });
  assert.equal(light.scopes[0].load.total, 101); assert.equal(v2DailyLoadMessage(light), null);
});

test('untimed load includes overdue cards still displayed today and removes completed cards using the existing private selector', async () => {
  const p = await privateFixture(); try {
    const { snapshot } = await readPersonalPlannerOverlaySnapshot(p.database);
    const chore = { ...snapshot.chores.find(row => row.id === p.chore.id), load: 'heavy' };
    const entry = { id: 'overdue-load', choreId: chore.id, householdId: chore.householdId, cycleBaseDate: addDays(anchorDate, -1),
      suggestedDate: addDays(anchorDate, -1), windowStart: addDays(anchorDate, -2), windowEnd: anchorDate, status: 'scheduled', assignedMemberIds: [] };
    const data = { ...snapshot, chores: [chore], scheduleEntries: [entry], completions: [] };
    const privateOverlay = projectV2PrivateTasks({ ownerUserId: 'a', snapshot: data, today: anchorDate, timeZone: 'Asia/Tokyo' }, 'a', { from: addDays(anchorDate, -2), through: anchorDate });
    assert.equal(privateOverlay.dailyLoad[anchorDate], undefined); assert.equal(privateOverlay.home.length, 1);
    const f = await fixture(); const before = JSON.stringify(data); const result = assess(f, { privateOverlay });
    assert.equal(result.scopes[0].load.heavy, 1); assert.match(v2DailyLoadMessage(result), /重い家事1件/u); assert.equal(JSON.stringify(data), before);
    data.completions = [{ id: 'done', householdId: chore.householdId, choreId: chore.id, scheduleEntryId: entry.id, scheduledDate: entry.suggestedDate,
      completedAt: '2026-10-27T01:00:00Z', completedLocalDate: anchorDate, outcome: 'completed' }];
    const completed = projectV2PrivateTasks({ ownerUserId: 'a', snapshot: data, today: anchorDate, timeZone: 'Asia/Tokyo' }, 'a', { from: addDays(anchorDate, -2), through: anchorDate });
    assert.equal(assess(f, { privateOverlay: completed }).scopes[0].load.heavy, 0);
  } finally { p.connection.close(); }
});

test('untimed load accepts shared tzdb regions even when an older Native Intl cannot format that timezone', async () => {
  const f = await fixture(); f.make('settings', { timeZone: 'America/Coyhaique' }, { entityId: 'settings' });
  const model = { viewerUserId: 'a', plan: f.plan() }; const original = Intl.DateTimeFormat;
  try {
    Intl.DateTimeFormat = function () { throw new RangeError('Simulated older Android timezone data'); };
    const result = assessV2UntimedDailyLoad({ model, userId: 'a', limits,
      privateOverlay: overlay({ [anchorDate]: { heavy: 1, normal: 0, total: 1 } }, { timeZone: 'America/Coyhaique' }) });
    assert.equal(result.scopes[0].timeZone, 'America/Coyhaique'); assert.deepEqual(result.scopes[0].reached, ['heavy']);
    assert.throws(() => assessV2UntimedDailyLoad({ model: { ...model, plan: { ...model.plan, timeZone: 'Invalid/Region' } }, userId: 'a', limits }), /地域/u);
  } finally { Intl.DateTimeFormat = original; }
});

for (const platform of ['ios', 'android']) test(`${platform} untimed daily-load UI shows counts without a time picker or move confirmation`, async () => {
  const f = await fixture(); const assessment = assess(f, { limits: { heavyDailyLimit: 1, normalDailyLimit: 1 } });
  const screen = screenHarness('src/features/sharing/v2-ui/daily-load-notice.tsx', { platform, exportName: 'V2DailyLoadNotice', props: { assessment } });
  assert.match(screen.text(), /上限に達しています/u); assert.match(screen.text(), /時刻の入力は不要/u);
  assert.equal(screen.nodes().filter(node => ['TextInput', 'Switch'].includes(node.type)).length, 0);
  const quiet = screenHarness('src/features/sharing/v2-ui/daily-load-notice.tsx', { platform, exportName: 'V2DailyLoadNotice', props: { assessment: assess(f) } }); assert.equal(quiet.text(), '');
});
