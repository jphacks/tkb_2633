import NextChoreWidget from '@/platform/widgets/NextChoreWidget';
import type { NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void {
    NextChoreWidget.updateSnapshot(snapshot);
  },
};
