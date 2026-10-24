import { StyleSheet, View } from 'react-native';

import { calendarCountColor } from '@/domain/calendar/count-colors';
import type { CalendarCountColors, CalendarCountDisplayMode } from '@/domain/shared/types';

export function CalendarTaskCountIndicator({ count, colors, mode, selected = false }: {
  count: number;
  colors: CalendarCountColors;
  mode: CalendarCountDisplayMode;
  selected?: boolean;
}) {
  const color = calendarCountColor(count, colors);
  if (!color) return <View style={styles.container} />;

  if (mode === 'bar') {
    return (
      <View style={styles.container}>
        <View style={[styles.bar, { backgroundColor: color }, selected && styles.selectedMarker]} />
      </View>
    );
  }

  const dotCount = count <= 4 ? count : count <= 9 ? count - 4 : Math.min(count - 9, 5);
  return (
    <View style={styles.container}>
      {Array.from({ length: dotCount }, (_, index) => (
        <View key={index} style={[styles.dot, { backgroundColor: color }, selected && styles.selectedMarker]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minHeight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  bar: { width: 14, height: 3, borderRadius: 2 },
  dot: { width: 4, height: 4, borderRadius: 2 },
  selectedMarker: { borderColor: '#FFFFFF', borderWidth: 0.5 },
});
