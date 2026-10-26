import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { useCallback, useEffect } from 'react';
import { useColorScheme } from 'react-native';

import { initializeLocalDatabase } from '@/platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { PlannerDataProvider, usePlannerData } from '@/hooks/use-planner-data';
import { addWidgetUserInteractionListener } from '../platform/widgets/widget-interaction-listener';
import { PlannerSystemBars } from '@/components/planner-system-bars';
import { NotificationWorkspaceBridge } from '@/components/notification-workspace-bridge';
import { WorkspaceProvider, ActiveWorkspaceScope, useWorkspace } from '@/hooks/use-workspace';
import '@/platform/notifications/configure-foreground-notifications';

function WidgetInteractionBridge() {
  const { database, refresh } = usePlannerData();
  const { switchTo, active } = useWorkspace();

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      await refresh({ widgetCompletionIds: [scheduleEntryId] });
      if (active) await switchTo(null);
      syncGoogleTasksAfterLocalCompletion(database);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database, refresh, switchTo, active]);

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
      <PlannerDataProvider>
        <WorkspaceProvider>
        <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
          <>
            <PlannerSystemBars />
            <WidgetInteractionBridge />
            <NotificationWorkspaceBridge />
            <ActiveWorkspaceScope>
            <Stack screenOptions={{ headerShown: false, animation: 'slide_from_right' }}>
              <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
              <Stack.Screen name="help" options={{ headerShown: false }} />
              <Stack.Screen name="chores" options={{ headerShown: false, animationTypeForReplace: 'pop' }} />
              <Stack.Screen name="settings" />
              <Stack.Screen name="settings/chore/[id]" options={{ headerShown: false }} />
              <Stack.Screen name="history" />
              <Stack.Screen name="waste" options={{ headerShown: false }} />
              <Stack.Screen name="sharing" options={{ headerShown: false }} />
            </Stack>
            </ActiveWorkspaceScope>
          </>
        </ThemeProvider>
        </WorkspaceProvider>
      </PlannerDataProvider>
    </SQLiteProvider>
  );
}
