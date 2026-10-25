import { useFocusEffect } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';

import { millisecondsUntilNextLocalDay } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot } from '@/platform/storage/repository';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { subscribeToGooglePlannerChanges } from '@/features/google-sync/planner-change-events';

export function usePlannerData() {
  const database = useSQLiteContext();
  const [snapshot, setSnapshot] = useState<PlannerSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const refreshRevision = useRef(0);

  const refresh = useCallback(async (options: { waitForWeather?: boolean } = {}) => {
    const revision = ++refreshRevision.current;
    try {
      const { snapshot: data, canPublishWidget } = await refreshPlannerFromWidget(database);
      if (revision !== refreshRevision.current) return;
      setSnapshot(data);
      if (Platform.OS !== 'web') void syncDailyHouseworkDigest(expoLocalNotificationGateway, data).catch(() => {});
      setError(null);

      if (data.settings.weatherLocation) {
        const weatherRefresh = applyWeatherToPlannerSnapshot(
          database,
          data,
          () => revision === refreshRevision.current,
        ).then((weatherData) => {
          if (!weatherData || revision !== refreshRevision.current) return;
          setSnapshot(weatherData);
          if (canPublishWidget) publishTodayWidgetSnapshot(weatherData);
          if (Platform.OS !== 'web') void syncDailyHouseworkDigest(expoLocalNotificationGateway, weatherData).catch(() => {});
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
    const unsubscribeGoogleChanges = subscribeToGooglePlannerChanges(() => { void refresh(); });
    void refresh();
    let appState = AppState.currentState;
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const scheduleMidnightRefresh = () => {
      clearTimeout(midnightTimer);
      midnightTimer = setTimeout(() => {
        void refresh();
        scheduleMidnightRefresh();
      }, millisecondsUntilNextLocalDay(new Date()) + 100);
    };
    scheduleMidnightRefresh();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active' && appState !== 'active') {
        void refresh();
        scheduleMidnightRefresh();
      } else if (state !== 'active') {
        clearTimeout(midnightTimer);
        refreshRevision.current += 1;
      }
      appState = state;
    });
    return () => {
      unsubscribeGoogleChanges();
      refreshRevision.current += 1;
      clearTimeout(midnightTimer);
      subscription.remove();
    };
  }, [refresh]));

  return { snapshot, loading, error, refresh, database };
}
