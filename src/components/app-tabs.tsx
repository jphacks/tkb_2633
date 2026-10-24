import { Tabs } from 'expo-router';
import { StyleSheet, Text, View, type ColorValue } from 'react-native';
import { palette } from '@/components/planner-ui';

function tabIcon(symbol: string) {
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean; size: number }) {
    return (
      <View style={[styles.iconWrap, focused && styles.iconWrapFocused]}>
        <Text style={{ color, fontSize: 20, lineHeight: 24, fontWeight: '600' }}>{symbol}</Text>
      </View>
    );
  }
  return TabIcon;
}

export default function AppTabs() {
  return (
    <Tabs screenOptions={{
      headerShown: false,
      tabBarActiveTintColor: palette.accent,
      tabBarInactiveTintColor: palette.muted,
      tabBarStyle: { backgroundColor: '#FFFFFF', borderTopColor: palette.border, borderTopWidth: 1 },
      tabBarLabelStyle: { fontSize: 11, fontWeight: '600' },
      tabBarItemStyle: { paddingTop: 2 },
    }}>
      <Tabs.Screen name="index" options={{ title: 'ホーム', tabBarIcon: tabIcon('⌂') }} />
      <Tabs.Screen name="explore" options={{ title: 'カレンダー', tabBarIcon: tabIcon('▦') }} />
      <Tabs.Screen name="manual" options={{ title: '説明', tabBarIcon: tabIcon('▤') }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { width: 48, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  iconWrapFocused: { backgroundColor: palette.accentSoft },
});
