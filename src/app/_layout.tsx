import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { useCallback, useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { initializeLocalDatabase, loadGoogleSyncState, LOCAL_HOUSEHOLD_ID } from '@/platform/storage/repository';
import { registerGoogleSyncBackgroundTask } from '@/features/google-sync/background-task';
import { syncGoogleTasks, syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';
import { addWidgetUserInteractionListener } from '../platform/widgets/widget-interaction-listener';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import '@/platform/notifications/configure-foreground-notifications';

function WidgetInteractionBridge() {
  const database = useSQLiteContext();

  useEffect(() => {
    const syncIfDue = async () => {
      const state = await loadGoogleSyncState(database, LOCAL_HOUSEHOLD_ID);
      if (!state?.enabled) return;
      await registerGoogleSyncBackgroundTask().catch(() => false);
      await syncGoogleTasks(database);
    };
    void syncIfDue().catch(() => undefined);
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void syncIfDue().catch(() => undefined);
    });
    return () => appStateSubscription.remove();
  }, [database]);

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      const { snapshot } = await refreshPlannerFromWidget(database, [scheduleEntryId]);
      await syncDailyHouseworkDigest(expoLocalNotificationGateway, snapshot);
      syncGoogleTasksAfterLocalCompletion(database);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database]);

  useEffect(() => {
    const interactionSubscription = addWidgetUserInteractionListener((event) => {
      const prefix = 'complete:';
      if (event.source === 'NextChoreWidget' && event.target.startsWith(prefix)) {
        void processCompletion(event.target.slice(prefix.length));
      }
    });
    return () => {
      interactionSubscription.remove();
    };
  }, [processCompletion]);

  return null;
}

export default function RootLayout() {
  const colorScheme = useColorScheme();
  return (
    <SQLiteProvider databaseName="housework.db" onInit={initializeLocalDatabase}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <>
          <WidgetInteractionBridge />
          <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
            <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
            <Stack.Screen name="help" options={{ headerShown: false }} />
            <Stack.Screen name="chores" options={{ headerShown: false }} />
            <Stack.Screen name="settings" />
            <Stack.Screen name="settings/chore/[id]" options={{ headerShown: false }} />
            <Stack.Screen name="history" />
            <Stack.Screen name="waste" options={{ headerShown: false }} />
          </Stack>
        </>
      </ThemeProvider>
    </SQLiteProvider>
  );
}
