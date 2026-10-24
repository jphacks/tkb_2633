import assert from 'node:assert/strict';
import test from 'node:test';

import { createTodayWidgetSnapshot } from '../src/features/widgets/today-widget-snapshot.ts';

test('widget displays at most three today chores in scheduler priority order', () => {
  const entries = [
    { choreId: 'future', status: 'scheduled', suggestedDate: '2026-10-27' },
    { choreId: 'normal', status: 'scheduled', suggestedDate: '2026-10-24' },
    { choreId: 'overdue', status: 'overdue', suggestedDate: '2026-10-20' },
    { choreId: 'window', status: 'inWindow', suggestedDate: '2026-10-24' },
    { choreId: 'initial', status: 'initialPending', suggestedDate: '2026-10-24' },
  ];
  const chores = [
    { id: 'future', name: '明後日の家事' },
    { id: 'normal', name: '洗濯' },
    { id: 'overdue', name: '期限超過の家事' },
    { id: 'window', name: '実施期間中の家事' },
    { id: 'initial', name: '初回の家事' },
  ];
  const snapshot = createTodayWidgetSnapshot(entries, chores, '2026-10-24', '2026-10-24T00:00:00.000Z');
  assert.deepEqual(snapshot.todayChoreNames, ['期限超過の家事', '実施期間中の家事', '初回の家事']);
  assert.equal(snapshot.todayChoreNames.length, 3);
  assert.equal(snapshot.remainingCount, 1);
});
