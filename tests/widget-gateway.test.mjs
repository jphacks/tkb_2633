import assert from 'node:assert/strict';
import test from 'node:test';
import { loadNativeModule } from './helpers/native-module.mjs';

function fixture(platform = 'ios') {
  const updates = []; let entries = []; let timelineReads = 0; let fail = false;
  const gateway = loadNativeModule('src/platform/widgets/expo-widget-gateway.ts', {
    'react-native': { Platform: { OS: platform } },
    '@/platform/widgets/NextChoreWidget': {
      __esModule: true, default: {
        updateSnapshot(snapshot) { if (fail) throw new Error('Native update failed'); updates.push(snapshot); },
        async getTimeline() { timelineReads++; return entries; },
      },
    },
  }).expoWidgetGateway;
  return { gateway, updates, setTimeline(value) { entries = value; }, reads: () => timelineReads, setFailure(value) { fail = value; } };
}

const snapshot = { chores: [{ id: 'one', name: '掃除', completed: true }], remainingCount: 0, updatedAt: '2026-10-26T00:00:00Z' };

test('iOS acknowledges a pending widget tap even when the planner content was already published', async () => {
  const h = fixture();
  h.gateway.updateNextChore(snapshot);
  h.gateway.updateNextChore({ ...snapshot, updatedAt: '2026-10-26T00:01:00Z' });
  assert.equal(h.updates.length, 1);
  h.setTimeline([{ date: new Date('2026-10-25'), props: { pendingWidgetCompletionIds: ['old'] } },
    { date: new Date('2026-10-26'), props: { pendingWidgetCompletionIds: ['one'] } }]);
  assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), ['one']);
  h.gateway.updateNextChore(snapshot);
  assert.equal(h.updates.length, 2, 'native actions must be acknowledged even if the chore was already completed');
  assert.deepEqual(h.updates.at(-1).pendingWidgetCompletionIds, []);
  h.setTimeline([{ date: new Date('2026-10-26'), props: h.updates.at(-1) }]);
  assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), []);
  h.gateway.updateNextChore(snapshot);
  assert.equal(h.updates.length, 2, 'acknowledged, unchanged content should remain deduplicated');
});

for (const platform of ['ios', 'android']) {
  test(`${platform} widget retries failed publishing and deduplicates successful unchanged content`, async () => {
    const h = fixture(platform);
    h.setFailure(true);
    assert.throws(() => h.gateway.updateNextChore(snapshot), /Native update failed/);
    h.setFailure(false);
    h.gateway.updateNextChore(snapshot);
    assert.deepEqual(await h.gateway.getPendingWidgetCompletionIds(), []);
    h.gateway.updateNextChore(snapshot);
    assert.equal(h.updates.length, 1);
    assert.equal(h.reads(), platform === 'ios' ? 1 : 0);
  });
}
