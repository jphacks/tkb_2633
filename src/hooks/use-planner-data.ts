import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useRef, useState } from 'react';

import { formatJapaneseDate } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot, loadPlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';

export function usePlannerData() {
  const database = useSQLiteContext();
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRevision = useRef(0);

  const publishWidgetSnapshot = useCallback((data: PlannerSnapshot) => {
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
  }, []);

  const refresh = useCallback(async (options: { waitForWeather?: boolean } = {}) => {
    const revision = ++refreshRevision.current;
    try {
      const data = await loadPlannerSnapshot(database);
      if (revision !== refreshRevision.current) return;
      setSnapshot(data);
      publishWidgetSnapshot(data);
      setError(null);

      if (data.settings.weatherLocation) {
        const weatherRefresh = applyWeatherToPlannerSnapshot(
          database,
          data,
          () => revision === refreshRevision.current,
        ).then((weatherData) => {
          if (revision !== refreshRevision.current) return;
          setSnapshot(weatherData);
          publishWidgetSnapshot(weatherData);
        }).catch((cause) => {
          if (revision === refreshRevision.current) {
            setError(cause instanceof Error ? cause.message : '天気に合わせて予定を保存できませんでした');
          }
        });
        if (options.waitForWeather) await weatherRefresh;
        else void weatherRefresh;
      }
    } catch (cause) {
      if (revision === refreshRevision.current) {
        setError(cause instanceof Error ? cause.message : 'データを読み込めませんでした');
      }
    } finally {
      if (revision === refreshRevision.current) setLoading(false);
    }
  }, [database, publishWidgetSnapshot]);

  useFocusEffect(useCallback(() => {
    void refresh();
    return () => { refreshRevision.current += 1; };
  }, [refresh]));

  return { snapshot, loading, error, refresh, database };
}
