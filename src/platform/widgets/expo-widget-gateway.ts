import NextChoreWidget from '@/platform/widgets/NextChoreWidget';
import type { NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void {
    NextChoreWidget.updateSnapshot({
      firstChore: snapshot.todayChoreNames[0] ?? '',
      secondChore: snapshot.todayChoreNames[1] ?? '',
      thirdChore: snapshot.todayChoreNames[2] ?? '',
      remainingCount: Math.max(0, snapshot.remainingCount),
      updatedAt: snapshot.updatedAt,
    });
  },
};
