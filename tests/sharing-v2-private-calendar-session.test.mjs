import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { createV2ScreenSession } from '../src/features/sharing/v2-ui/screen-session.ts';

const now = () => new Date('2026-10-27T10:00:00.000Z');
const settings = { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } };
const binding = { ownerUserId: 'a', accountGeneration: 'private-generation', mainDeviceId: 'own-main', mainRevision: 2, calendarBinding: 'opaque-private-source' };
function busy() { return { ownerUserId: 'a', binding, cache: { ...binding, timeZone: 'Asia/Tokyo', fetchedAt: '2026-10-27T09:00:00.000Z',
  coverage: { start: '2026-10-26T15:00:00.000Z', end: '2026-11-28T15:00:00.000Z' }, intervals: [{ start: '2026-10-27T00:00:00.000Z', end: '2026-10-27T10:00:00.000Z' }] } }; }
async function base() {
  const f = await fixture({ preset: 'assigned', members: ['a'], before: 0 }); f.make('chore', { load: 'heavy' }, { entityId: 'floor' });
  const model = { viewerUserId: 'a', plan: f.plan() }; const controller = { readModel: async () => model };
  return { input: { controller, groupId: model.plan.groupId, userId: 'a', now, readPreferences: () => ({ ownerUserId: 'a', settings }) }, model };
}

test('v2 screen session reads the own local Calendar once and changes only private recommendations without exporting intervals or binding', async () => {
  const f = await base(); let reads = 0; const before = JSON.stringify(f.model.plan); const baseline = await createV2ScreenSession(f.input).readModel();
  const readOwnCalendar = async () => ({ kind: 'conflict' });
  const session = createV2ScreenSession({ ...f.input, calendar: { readForPlan: async () => { reads++; return busy(); }, readOwnCalendar } });
  const value = await session.readModel(); assert.equal(reads, 1); assert.equal(value.plan.planHash, baseline.plan.planHash); assert.equal(JSON.stringify(f.model.plan), before);
  const first = baseline.personal.recommendations.find(row => row.date === '2026-10-27'); assert.ok(first);
  assert.equal(value.personal.recommendations.find(row => row.subjectOccurrenceId === first.subjectOccurrenceId).date, '2026-10-28');
  assert.equal(session.readOwnCalendar, readOwnCalendar);
  for (const text of ['opaque-private-source', 'private-generation', 'intervals', 'fetchedAt', 'binding']) assert.equal(JSON.stringify(value).includes(text), false, text);
});

test('v2 screen session skips private Calendar entirely during management and treats private read failures as unconfirmed', async () => {
  const f = await base(); let reads = 0; const session = createV2ScreenSession({ ...f.input, calendar: {
    readForPlan: async () => { reads++; throw new Error('protected data unavailable'); }, readOwnCalendar: async () => { throw new Error('not invoked by render'); } } });
  assert.equal((await session.readModel({ management: true })).personal, undefined); assert.equal(reads, 0);
  const result = await session.readModel(); assert.equal(reads, 1); assert.ok(result.personal.recommendations.every(row => row.calendar.kind === 'unknown'));
});

test('v2 screen session rejects a different owner in any private Calendar binding before building a personal recommendation', async () => {
  const f = await base();
  for (const change of [value => { value.ownerUserId = 'b'; }, value => { value.binding = { ...value.binding, ownerUserId: 'b' }; }, value => { value.cache.ownerUserId = 'b'; }]) {
    const value = busy(); change(value); const session = createV2ScreenSession({ ...f.input, calendar: { readForPlan: async () => value, readOwnCalendar: async () => ({ kind: 'clear' }) } });
    await assert.rejects(() => session.readModel(), /本人のCalendar/u);
  }
});
