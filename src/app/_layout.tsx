import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { addUserInteractionListener } from 'expo-widgets';
import { useCallback, useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { initializeLocalDatabase } from '@/platform/storage/repository';
import { syncDailyHouseworkDigest } from '@/features/notifications/daily-housework-digest';
import { refreshPlannerFromWidget } from '@/platform/widgets/refresh-planner-from-widget';
import { expoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import '@/platform/notifications/configure-foreground-notifications';

function WidgetInteractionBridge() {
  const database = useSQLiteContext();

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      const { snapshot } = await refreshPlannerFromWidget(database, [scheduleEntryId]);
      await syncDailyHouseworkDigest(expoLocalNotificationGateway, snapshot);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database]);

  useEffect(() => {
    const interactionSubscription = addUserInteractionListener((event) => {
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
