import { DarkTheme, DefaultTheme, Stack, ThemeProvider } from 'expo-router';
import { SQLiteProvider, useSQLiteContext } from 'expo-sqlite';
import { addUserInteractionListener } from 'expo-widgets';
import { useCallback, useEffect } from 'react';
import { AppState, useColorScheme } from 'react-native';

import { completionMatchesEntry } from '@/domain/scheduling/completion-matching';
import { completeChore, initializeLocalDatabase, loadPlannerSnapshot } from '@/platform/storage/repository';
import { publishTodayWidgetSnapshot } from '@/features/widgets/publish-today-widget-snapshot';
import { expoWidgetGateway } from '@/platform/widgets/expo-widget-gateway';

function WidgetInteractionBridge() {
  const database = useSQLiteContext();

  const processCompletion = useCallback(async (scheduleEntryId: string) => {
    try {
      let snapshot = await loadPlannerSnapshot(database);
      const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === scheduleEntryId);
      if (entry && !snapshot.completions.some((completion) => completionMatchesEntry(completion, entry))) {
        await completeChore(database, entry, undefined, 'widget');
        snapshot = await loadPlannerSnapshot(database);
      }
      publishTodayWidgetSnapshot(snapshot);
    } catch {
      // Widget actions should not interrupt the app if local data cannot be refreshed.
    }
  }, [database]);

  const processPendingCompletions = useCallback(async () => {
    const pendingIds = await expoWidgetGateway.getPendingWidgetCompletionIds();
    for (const scheduleEntryId of pendingIds) {
      await processCompletion(scheduleEntryId);
    }
  }, [processCompletion]);

  useEffect(() => {
    const interactionSubscription = addUserInteractionListener((event) => {
      const prefix = 'complete:';
      if (event.source === 'NextChoreWidget' && event.target.startsWith(prefix)) {
        void processCompletion(event.target.slice(prefix.length));
      }
    });
    void processPendingCompletions();
    const appStateSubscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void processPendingCompletions();
    });

    return () => {
      interactionSubscription.remove();
      appStateSubscription.remove();
    };
  }, [processCompletion, processPendingCompletions]);

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
