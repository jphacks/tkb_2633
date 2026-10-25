import { StyleSheet, View } from 'react-native';

import { calendarCountColor, calendarDotCount } from '@/domain/calendar/count-colors';
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

  const dotCount = calendarDotCount(count);
  return (
    <View style={styles.container}>
      {Array.from({ length: dotCount }, (_, index) => (
        <View key={index} style={[styles.dot, { backgroundColor: color }, selected && styles.selectedMarker]} />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minHeight: 9, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 1 },
  bar: { width: 18, height: 4, borderRadius: 2 },
  dot: { width: 6, height: 6, borderRadius: 3 },
  selectedMarker: { borderColor: '#FFFFFF', borderWidth: 0.5 },
});
