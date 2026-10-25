import assert from 'node:assert/strict';
import { test } from 'node:test';
import './helpers/typescript-loader.mjs';

const { parseGoogleCompletedAt } = await import('../src/features/google-sync/google-completion-policy.ts');
const { subscribeToGooglePlannerChanges, notifyGooglePlannerChanges } = await import('../src/features/google-sync/planner-change-events.ts');

test('Google completion timestamps require a valid explicit RFC3339 instant and preserve its time', () => {
  assert.equal(parseGoogleCompletedAt('2026-10-25T12:34:56.123+09:00'), '2026-10-25T03:34:56.123Z');
  assert.equal(parseGoogleCompletedAt('2024-02-29T00:00:00Z'), '2024-02-29T00:00:00.000Z');
  for (const invalid of [null, undefined, 123, '', '2026-10-25', 'yesterday', '2026-02-29T00:00:00Z',
    '2026-02-30T00:00:00Z', '2026-13-01T00:00:00Z', '2026-10-25T24:00:00Z', '2026-10-25T12:00:00+99:99']) {
    assert.equal(parseGoogleCompletedAt(invalid), null, String(invalid));
  }
});

test('planner views refresh on imports and detached listeners are not called', () => {
  let refreshes = 0;
  const unsubscribe = subscribeToGooglePlannerChanges(() => { refreshes += 1; });
  const detachBroken = subscribeToGooglePlannerChanges(() => { throw new Error('view unavailable'); });
  const detachSecond = subscribeToGooglePlannerChanges(() => { refreshes += 1; });
  notifyGooglePlannerChanges();
  assert.equal(refreshes, 2);
  unsubscribe();
  detachBroken();
  detachSecond();
  notifyGooglePlannerChanges();
  assert.equal(refreshes, 2);
});
