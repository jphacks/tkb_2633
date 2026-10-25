import { Tabs } from 'expo-router';
import { SymbolView, type SymbolViewProps } from 'expo-symbols';
import { StyleSheet, View, type ColorValue } from 'react-native';
import { palette } from '@/components/planner-ui';

function tabIcon(name: SymbolViewProps['name']) {
  function TabIcon({ color, focused }: { color: ColorValue; focused: boolean; size: number }) {
    return (
      <View style={[styles.iconWrap, focused && styles.iconWrapFocused]}>
        <SymbolView name={name} size={20} tintColor={color} weight="regular" />
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
      tabBarLabelStyle: { fontSize: 14, fontWeight: '600' },
      tabBarItemStyle: { paddingTop: 2 },
    }}>
      <Tabs.Screen name="index" options={{ title: 'ホーム', tabBarIcon: tabIcon({ ios: 'house', android: 'house' }) }} />
      <Tabs.Screen name="explore" options={{ title: 'カレンダー', tabBarIcon: tabIcon({ ios: 'calendar', android: 'calendar_month' }) }} />
      <Tabs.Screen name="guide" options={{ title: '家事', tabBarIcon: tabIcon({ ios: 'checklist', android: 'checklist' }) }} />
      <Tabs.Screen name="manual" options={{ title: '家電', tabBarIcon: tabIcon({ ios: 'robotic.vacuum', android: 'vacuum' }) }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconWrap: { width: 48, height: 30, borderRadius: 15, alignItems: 'center', justifyContent: 'center' },
  iconWrapFocused: { backgroundColor: palette.accentSoft },
});
