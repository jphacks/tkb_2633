import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { createTodayWidgetSnapshot } from '@/features/widgets/today-widget-snapshot';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';

export function publishTodayWidgetSnapshot(snapshot: PlannerSnapshot): void {
  expoWidgetGateway.updateNextChore(createTodayWidgetSnapshot(
    snapshot.scheduleEntries,
    snapshot.chores,
    snapshot.completions,
    localDateFromDate(new Date()),
    new Date().toISOString(),
  ));
}
