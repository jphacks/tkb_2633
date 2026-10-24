import { Platform } from 'react-native';

import type { NextChoreWidgetSnapshot, WidgetGateway } from '@/features/widgets/contracts';
import NextChoreWidget from '@/platform/widgets/NextChoreWidget';

let publishedSignature: string | undefined;

export const expoWidgetGateway: WidgetGateway = {
  updateNextChore(snapshot: NextChoreWidgetSnapshot): void {
    const signature = JSON.stringify([snapshot.chores, snapshot.remainingCount]);
    if (signature === publishedSignature) return;
    NextChoreWidget.updateSnapshot({
      chores: snapshot.chores,
      pendingWidgetCompletionIds: [],
      remainingCount: Math.max(0, snapshot.remainingCount),
      updatedAt: snapshot.updatedAt,
    });
    publishedSignature = signature;
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
