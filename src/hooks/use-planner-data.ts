import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';

import { formatJapaneseDate } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { loadPlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';

export function usePlannerData() {
  const database = useSQLiteContext();
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const data = await loadPlannerSnapshot(database);
      setSnapshot(data);
      const nextEntry = data.scheduleEntries
        .filter((entry) => entry.status !== 'overdue')
        .sort((left, right) => left.suggestedDate.localeCompare(right.suggestedDate))[0]
        ?? data.scheduleEntries.find((entry) => entry.status === 'overdue');
      const nextChore = nextEntry ? data.chores.find((chore) => chore.id === nextEntry.choreId) : undefined;
      const assignmentLabel = nextEntry?.assignedMemberIds
        .map((id) => data.members.find((member) => member.id === id)?.displayName)
        .filter(Boolean)
        .join('・');
      expoWidgetGateway.updateNextChore({
        choreId: nextEntry?.choreId ?? null,
        choreName: nextChore?.name ?? 'アプリで予定を設定',
        dateLabel: nextEntry
          ? nextEntry.windowStart === nextEntry.windowEnd
            ? formatJapaneseDate(nextEntry.windowStart)
            : `${formatJapaneseDate(nextEntry.windowStart)}〜${formatJapaneseDate(nextEntry.windowEnd)}`
          : '予定はまだありません',
        assignmentLabel,
        updatedAt: new Date().toISOString(),
      });
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'データを読み込めませんでした');
    } finally {
      setLoading(false);
    }
  }, [database]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  return { snapshot, loading, error, refresh, database };
}
