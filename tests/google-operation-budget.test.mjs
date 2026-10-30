import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoogleOperationBudget } from '../src/features/google-sync/operation-budget.ts';

test('Google operation budget includes queueing, cannot extend on join, and expires with an AbortSignal', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let now = 1000; const budget = createGoogleOperationBudget(100, () => now);
  try {
    now += 40; assert.equal(budget.remaining(), 60); budget.shrink(100); assert.equal(budget.remaining(), 60);
    budget.shrink(20); assert.equal(budget.remaining(), 20); t.mock.timers.tick(20); await budget.expiration;
    assert.equal(budget.signal.aborted, true); assert.throws(budget.assert, { code: 'timeout' });
  } finally { budget.close(); }
});
test('Google operation budget does not gain time when the device clock moves backwards', t => {
  t.mock.timers.enable({ apis: ['setTimeout'] }); let now = 1000; const budget = createGoogleOperationBudget(100, () => now);
  try {
    now += 40; assert.equal(budget.remaining(), 60); now = 1; assert.equal(budget.remaining(), 60);
    t.mock.timers.tick(100); assert.throws(budget.assert, { code: 'timeout' });
  } finally { budget.close(); }
});
test('Google operation budget cleans transport listeners once and rejects invalid durations', () => {
  for (const value of [0, -1, NaN, Infinity, 110001, 1.5]) assert.throws(() => createGoogleOperationBudget(value));
  const budget = createGoogleOperationBudget(1000); let count = 0; budget.onClose(() => count++); budget.close(); budget.close();
  assert.equal(count, 1); budget.onClose(() => count++); assert.equal(count, 2); assert.throws(budget.assert, { code: 'timeout' });
});
