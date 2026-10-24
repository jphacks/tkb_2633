import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useRef, useState } from 'react';

import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot, loadPlannerSnapshot } from '@/platform/storage/repository';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';
import { createTodayWidgetSnapshot } from '@/features/widgets/today-widget-snapshot';

export function usePlannerData() {
  const database = useSQLiteContext();
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRevision = useRef(0);

  const publishWidgetSnapshot = useCallback((data: PlannerSnapshot) => {
    const today = localDateFromDate(new Date());
    expoWidgetGateway.updateNextChore(createTodayWidgetSnapshot(
      data.scheduleEntries,
      data.chores,
      today,
      new Date().toISOString(),
    ));
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
