import { Platform } from 'react-native';

import type { NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';
import NextChoreWidget from '@/platform/widgets/NextChoreWidget';

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void {
    NextChoreWidget.updateSnapshot({
      chores: snapshot.chores,
      pendingWidgetCompletionIds: [],
      remainingCount: Math.max(0, snapshot.remainingCount),
      updatedAt: snapshot.updatedAt,
    });
  },

  async getPendingWidgetCompletionIds(): Promise<readonly string[]> {
    if (Platform.OS !== 'ios') return [];
    const entries = await NextChoreWidget.getTimeline();
    const latest = entries.reduce<(typeof entries)[number] | null>(
      (current, entry) => !current || entry.date > current.date ? entry : current,
      null,
    );
    return latest?.props.pendingWidgetCompletionIds ?? [];
  },
};
