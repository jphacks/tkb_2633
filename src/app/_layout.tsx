import { DarkTheme, DefaultTheme, ThemeProvider } from 'expo-router';
import { SQLiteProvider } from 'expo-sqlite';
import { useColorScheme } from 'react-native';

import AppTabs from '@/components/app-tabs';
import { initializeLocalDatabase } from '@/platform/storage/repository';

export default function TabLayout() {
  const colorScheme = useColorScheme();
  return (
    <SQLiteProvider databaseName="housework.db" onInit={initializeLocalDatabase}>
      <ThemeProvider value={colorScheme === 'dark' ? DarkTheme : DefaultTheme}>
        <AppTabs />
      </ThemeProvider>
    </SQLiteProvider>
  );
}
