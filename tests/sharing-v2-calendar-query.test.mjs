import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2PlannerActions } from '../src/features/sharing/v2/actions.ts';
import { addDays } from '../src/domain/scheduling/local-date.ts';

const ref = { choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null };
async function setup() {
  const f = await fixture(); const d = await f.device(); await d.repository.commit(seeds()); let id = 0;
  return { d, a: createV2PlannerActions(d.repository, { makeId: () => `calendar-${++id}`, now }), close: () => d.connection.close() };
}
const query = (date) => ({ from: date, through: date, asOfDate: ref.anchorDate });

test('v2 calendar queries retain recurrence anchors outside the month for both earlier and later repeating manual dates', async () => {
  for (const offset of [-90, 90]) {
    const f = await setup(); const date = addDays(ref.anchorDate, offset);
    try {
      await f.a.changeDate(ref, { mode: 'day', target: { precision: 'date', date }, selector: { scope: 'ongoing', from: ref.anchorDate } });
      const plan = await f.a.readPlan(query(date)); const original = plan.occurrences.find((entry) => entry.choreId === ref.choreId && entry.anchorDate === ref.anchorDate);
      assert.ok(original); assert.equal(original.subjects[0].suggestedDate, date);
      assert.equal(new Set(plan.occurrences.map((entry) => entry.id)).size, plan.occurrences.length);
    } finally { f.close(); }
  }
});

test('v2 calendar inverse queries do not extend a limited repeating designation beyond its original anchor period', async () => {
  const f = await setup(); const date = addDays(ref.anchorDate, 90);
  try {
    await f.a.changeDate(ref, { mode: 'day', target: { precision: 'date', date }, selector: { scope: 'period', range: { from: ref.anchorDate, through: addDays(ref.anchorDate, 7) } } });
    assert.ok((await f.a.readPlan(query(date))).occurrences.some((entry) => entry.anchorDate === ref.anchorDate));
    const later = await f.a.readPlan(query(addDays(date, 14)));
    assert.equal(later.occurrences.some((entry) => entry.anchorDate === addDays(ref.anchorDate, 14)), false);
  } finally { f.close(); }
});

test('v2 calendar keeps a completed moved round on its recorded scheduled day after its designation was cancelled', async () => {
  const f = await setup(); const date = addDays(ref.anchorDate, 90);
  try {
    const [rule] = await f.a.changeDate(ref, { mode: 'day', target: { precision: 'date', date } });
    const [work] = await f.a.complete(ref); const before = (await f.a.readPlan(query(date))).history;
    await f.a.cancelDates(ref, [rule.operationId]);
    const plan = await f.a.readPlan(query(date)); const original = plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate);
    assert.ok(original, 'the actual completed round must stay available from its recorded calendar day');
    assert.equal(original.subjects[0].suggestedDate, date); assert.equal(original.subjects[0].completed, true);
    assert.deepEqual(original.subjects[0].completionOperationIds, [work.operationId]); assert.deepEqual(plan.history, before);
  } finally { f.close(); }
});

test('v2 a cancelled completion cannot recreate a moved calendar task after its old date rule was removed', async () => {
  const f = await setup(); const date = addDays(ref.anchorDate, 90);
  try {
    const [rule] = await f.a.changeDate(ref, { mode: 'day', target: { precision: 'date', date } }); const [work] = await f.a.complete(ref);
    await f.a.cancelDates(ref, [rule.operationId]); await f.a.undo(work.operationId);
    const plan = await f.a.readPlan(query(date)); assert.equal(plan.occurrences.some((entry) => entry.anchorDate === ref.anchorDate), false);
    assert.equal(plan.history[0].active, false);
    assert.equal((await f.a.readPlan(query(ref.anchorDate))).occurrences.find((entry) => entry.anchorDate === ref.anchorDate).completed, false);
  } finally { f.close(); }
});

test('v2 moved calendar history retains its original timezone and source after a later cadence and group timezone change', async () => {
  const f = await setup(); const date = '2027-01-26';
  try {
    const target = { precision: 'interval', start: `${date}T00:15:00.000Z`, end: `${date}T00:45:00.000Z` };
    const [rule] = await f.a.changeDate(ref, { mode: 'fixed', target }); const [work] = await f.a.complete(ref);
    const before = (await f.a.readPlan(query(date))).history;
    await f.a.cancelDates(ref, [rule.operationId]); await f.a.patchChoreConfiguration('floor', 1, { intervalDays: 14 }, '2026-10-28');
    await f.d.repository.commit([draft('new-zone', 'settings', 'settings', { timeZone: 'America/New_York' })]);
    const previous = process.env.TZ;
    try {
      let expected;
      for (const zone of ['UTC', 'Asia/Tokyo', 'America/Los_Angeles']) {
        process.env.TZ = zone; const plan = await f.a.readPlan(query(date));
        const original = plan.occurrences.find((entry) => entry.anchorDate === ref.anchorDate); assert.ok(original);
        assert.equal(original.ruleVersion, 1); assert.equal(original.subjects[0].suggestedDate, date); assert.deepEqual(plan.history, before);
        assert.deepEqual(original.subjects[0].completionOperationIds, [work.operationId]);
        if (expected) assert.equal(plan.planHash, expected); else expected = plan.planHash;
      }
    } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
  } finally { f.close(); }
});
