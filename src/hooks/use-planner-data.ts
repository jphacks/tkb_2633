import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useRef, useState } from 'react';

import { completionMatchesEntry } from '@/domain/scheduling/completion-matching';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot, completeChore, loadPlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';

export function usePlannerData() {
  const database = useSQLiteContext();
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRevision = useRef(0);

  const refresh = useCallback(async (options: { waitForWeather?: boolean } = {}) => {
    const revision = ++refreshRevision.current;
    try {
      let data = await loadPlannerSnapshot(database);
      try {
        const pendingIds = await expoWidgetGateway.getPendingWidgetCompletionIds();
        let completedFromWidget = false;
        for (const entryId of pendingIds) {
          const entry = data.scheduleEntries.find((candidate) => candidate.id === entryId);
          if (!entry || data.completions.some((completion) => completionMatchesEntry(completion, entry))) continue;
          completedFromWidget = (await completeChore(database, entry, undefined, 'widget')) || completedFromWidget;
        }
        if (completedFromWidget) data = await loadPlannerSnapshot(database);
      } catch {
        // Keep the planner usable if widget state cannot be read on this platform.
      }
      if (revision !== refreshRevision.current) return;
      setSnapshot(data);
      publishTodayWidgetSnapshot(data);
      setError(null);

      if (data.settings.weatherLocation) {
        const weatherRefresh = applyWeatherToPlannerSnapshot(
          database,
          data,
          () => revision === refreshRevision.current,
        ).then((weatherData) => {
          if (revision !== refreshRevision.current) return;
          setSnapshot(weatherData);
          publishTodayWidgetSnapshot(weatherData);
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
  }, [database]);

  useFocusEffect(useCallback(() => {
    void refresh();
    return () => { refreshRevision.current += 1; };
  }, [refresh]));

  return { snapshot, loading, error, refresh, database };
}
