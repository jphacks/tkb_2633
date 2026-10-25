import type { SQLiteDatabase } from 'expo-sqlite';

import { createWidgetCompletionSync } from '@/features/widgets/widget-completion-sync';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { completeChore, loadPlannerSnapshot, readCachedPlannerSnapshot } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';

const synchronizers = new WeakMap<SQLiteDatabase, ReturnType<typeof createWidgetCompletionSync<PlannerSnapshot>>>();

export function refreshPlannerFromWidget(database: SQLiteDatabase, requestedIds: readonly string[] = [], options: { publish?: boolean; preferCached?: boolean } = {}) {
  let synchronize = synchronizers.get(database);
  if (!synchronize) {
    synchronize = createWidgetCompletionSync({
      load: async (preferCached) => (preferCached ? readCachedPlannerSnapshot(database) : null) ?? loadPlannerSnapshot(database),
      pendingIds: () => expoWidgetGateway.getPendingWidgetCompletionIds(),
      complete: (entry) => completeChore(database, entry, undefined, 'widget'),
      publish: publishTodayWidgetSnapshot,
    });
    synchronizers.set(database, synchronize);
  }
  return synchronize(requestedIds, options);
}
