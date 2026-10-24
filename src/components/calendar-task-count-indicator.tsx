import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/components/planner-ui';
import { calendarCountColor } from '@/domain/calendar/count-colors';
import type { CalendarCountColors } from '@/domain/shared/types';

export function CalendarTaskCountIndicator({ count, colors, selected = false }: {
  count: number;
  colors: CalendarCountColors;
  selected?: boolean;
}) {
  const color = calendarCountColor(count, colors);
  if (!color) return <View style={styles.container} />;

  return (
    <View style={styles.container}>
      {Array.from({ length: Math.min(count, 3) }, (_, index) => (
        <View key={index} style={[styles.bar, { backgroundColor: color }, selected && styles.selectedBar]} />
      ))}
      {count > 3 ? <Text style={styles.moreCount}>+{count - 3}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { minHeight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 2 },
  bar: { width: 7, height: 3, borderRadius: 2 },
  selectedBar: { borderColor: '#FFFFFF', borderWidth: 0.5 },
  moreCount: { color: palette.muted, fontSize: 8, lineHeight: 9 },
});
