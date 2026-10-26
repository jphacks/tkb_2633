import { NavigationBar } from 'expo-navigation-bar';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';

/** Planner screens use white surfaces, including when the device prefers dark mode. */
export function PlannerSystemBars() {
  return (
    <>
      <StatusBar style="dark" hidden={false} />
      {Platform.OS === 'android' ? <NavigationBar style="dark" hidden={false} /> : null}
    </>
  );
}
