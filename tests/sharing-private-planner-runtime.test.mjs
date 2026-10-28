import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { privateCalendarRuntimeFixture } from './helpers/private-calendar-runtime.mjs';
import { createPrivatePlannerPreferenceStore } from '../src/features/sharing/private-planner/preference-store.ts';

test('private planner normal runtime reads only its protected profile without creating Calendar identity keys consent or cloud writes', async t => {
  const f = privateCalendarRuntimeFixture(t);
  f.port.plannerPreferences = createPrivatePlannerPreferenceStore({ ownerUserId: f.userId, vault: f.f.vault, exclusive: f.f.exclusive,
    assertOwner: owner => assert.equal(f.f.state.currentUser, owner) });
  const runtime = f.open(); assert.equal(await runtime.readPlannerPreferences(), null);
  const saved = await f.port.plannerPreferences.save(0, { timeZone: 'Asia/Tokyo', restDays: [2], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 }, allowedBands: [] });
  assert.deepEqual(await runtime.readPlannerPreferences(), saved); assert.equal(await f.f.secrets.publicState(f.userId), null);
  assert.equal(f.state.googleReads, 0); assert.equal(f.state.restores, 0); assert.deepEqual(f.state.consents, []); assert.equal(f.transport.history.length, 0);
});

test('private planner normal runtime rejects a foreign profile and account changes after a protected read', async t => {
  const f = privateCalendarRuntimeFixture(t);
  f.port.plannerPreferences = { read: async () => ({ ownerUserId: 'foreign' }) }; await assert.rejects(() => f.open().readPlannerPreferences(), /本人/u);
  f.port.plannerPreferences = { read: async () => { f.f.state.currentUser = 'foreign'; return null; } };
  await assert.rejects(() => f.open().readPlannerPreferences(), /owner changed/u); assert.equal(f.state.googleReads, 0); assert.equal(f.transport.history.length, 0);
});
