import { Tabs } from 'expo-router';
import { palette } from '@/components/planner-ui';

export default function AppTabs() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: palette.accent,
      tabBarInactiveTintColor: palette.muted,
      tabBarStyle: { backgroundColor: '#FBFAF7', borderTopColor: palette.border },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
    }}>
      <Tabs.Screen name="index" options={{ title: '今日' }} />
      <Tabs.Screen name="explore" options={{ title: 'カレンダー' }} />
      <Tabs.Screen name="chores" options={{ title: '家事' }} />
      <Tabs.Screen name="history" options={{ title: '履歴' }} />
      <Tabs.Screen name="settings" options={{ title: '設定' }} />
      <Tabs.Screen name="waste" options={{ href: null }} />
    </Tabs>
  );
}
