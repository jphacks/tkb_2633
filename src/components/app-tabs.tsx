import { Tabs } from 'expo-router';
import { Text, type ColorValue } from 'react-native';
import { palette } from '@/components/planner-ui';

function tabIcon(symbol: string) {
  function TabIcon({ color, size }: { color: ColorValue; size: number }) {
    return <Text style={{ color, fontSize: size, lineHeight: size + 4, fontWeight: '600' }}>{symbol}</Text>;
  }
  return TabIcon;
}

export default function AppTabs() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: palette.accent,
      tabBarInactiveTintColor: palette.muted,
      tabBarStyle: { backgroundColor: '#FBFAF7', borderTopColor: palette.border },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
    }}>
      <Tabs.Screen name="index" options={{ title: '今日', tabBarIcon: tabIcon('⌂') }} />
      <Tabs.Screen name="explore" options={{ title: 'カレンダー', tabBarIcon: tabIcon('▦') }} />
      <Tabs.Screen name="chores" options={{ title: '家事', tabBarIcon: tabIcon('✓') }} />
      <Tabs.Screen name="history" options={{ title: '履歴', tabBarIcon: tabIcon('↺') }} />
      <Tabs.Screen name="settings" options={{ title: '設定', tabBarIcon: tabIcon('⚙︎') }} />
      <Tabs.Screen name="waste" options={{ href: null }} />
    </Tabs>
  );
}
