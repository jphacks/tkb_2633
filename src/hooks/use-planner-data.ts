import { useSQLiteContext } from 'expo-sqlite';
import type { SQLiteDatabase } from 'expo-sqlite';
import { createContext, createElement, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import { AppState } from 'react-native';

import { millisecondsUntilNextLocalDay } from '@/domain/scheduling/local-date';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { applyWeatherToPlannerSnapshot, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID } from '@/platform/storage/repository';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import { subscribeToGooglePlannerChanges } from '@/features/google-sync/planner-change-events';
import { registerGoogleSyncBackgroundTask } from '@/features/google-sync/background-task';
import { syncGoogleTasks } from '@/features/google-sync/coordinator';
import { createPlannerRefreshController } from '@/features/planner/refresh-controller';

type PlannerController = ReturnType<typeof createPlannerRefreshController<PlannerSnapshot>>;
const PlannerContext = createContext<{ database: SQLiteDatabase; controller: PlannerController } | null>(null);

/** The only foreground owner of planner reads, lifecycle subscriptions and snapshot side effects. */
export function PlannerDataProvider({ children }: { children: ReactNode }) {
  const database = useSQLiteContext();
  const controller = useMemo(() => createPlannerRefreshController<PlannerSnapshot>({
    load: (ids, force) => refreshPlannerFromWidget(database, ids, { publish: false, preferCached: !force }),
    weather: (snapshot, canCommit) => snapshot.settings.weatherLocation
      ? applyWeatherToPlannerSnapshot(database, snapshot, canCommit) : Promise.resolve(null),
    publish: (snapshot, canPublishWidget) => {
      if (canPublishWidget) publishTodayWidgetSnapshot(snapshot);
      return syncDailyHouseworkDigest(expoLocalNotificationGateway, snapshot).then(() => undefined);
    },
  }), [database]);

  useEffect(() => {
    let appState = AppState.currentState;
    let midnightTimer: ReturnType<typeof setTimeout> | undefined;
    const syncGoogleIfDue = async () => {
      const state = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      if (!state?.enabled) return;
      await registerGoogleSyncBackgroundTask().catch(() => false);
      await syncGoogleTasks(database);
    };
    const scheduleMidnight = () => {
      clearTimeout(midnightTimer);
      midnightTimer = setTimeout(() => {
        void controller.refresh({ force: true });
        scheduleMidnight();
      }, millisecondsUntilNextLocalDay(new Date()) + 100);
    };
    const resume = () => {
      // Native/background work can use another SQLite connection, so bypass the JS cache on resume.
      void controller.refresh({ force: true });
      void syncGoogleIfDue().catch(() => undefined);
      scheduleMidnight();
    };
    if (appState !== 'background' && appState !== 'inactive') resume();
    const unsubscribe = subscribeToGooglePlannerChanges(() => {
      if (appState === 'background' || appState === 'inactive') return false;
      void controller.refresh();
      return true;
    });
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'active' && appState !== 'active') resume();
      else if (next !== 'active') {
        clearTimeout(midnightTimer);
        controller.invalidate();
      }
      appState = next;
    });
    return () => {
      unsubscribe();
      subscription.remove();
      clearTimeout(midnightTimer);
      controller.invalidate();
    };
  }, [controller, database]);

  const value = useMemo(() => ({ database, controller }), [database, controller]);
  return createElement(PlannerContext.Provider, { value }, children);
}

export function usePlannerData() {
  const context = useContext(PlannerContext);
  if (!context) throw new Error('usePlannerData must be used within PlannerDataProvider');
  const state = useSyncExternalStore(context.controller.subscribe, context.controller.getSnapshot, context.controller.getSnapshot);
  return { ...state, database: context.database, refresh: context.controller.refresh };
}
