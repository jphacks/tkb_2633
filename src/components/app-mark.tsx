import { StyleSheet, Text, View } from 'react-native';

import { palette } from '@/components/planner-ui';

export function AppMark({ size = 44 }: { size?: number }) {
  return (
    <View style={[styles.mark, { width: size, height: size, borderRadius: size * 0.29 }]}>
      <View style={styles.list}>
        {[0, 1, 2].map((row) => (
          <View key={row} style={styles.row}>
            <Text style={styles.check}>✓</Text>
            <View style={[styles.rule, row === 2 && styles.shortRule]} />
          </View>
        ))}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  mark: { alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accent },
  list: { gap: 1 },
  row: { height: 8, flexDirection: 'row', alignItems: 'center', gap: 3 },
  check: { color: '#FFFFFF', fontSize: 8, lineHeight: 9, fontWeight: '700' },
  rule: { width: 12, height: 1.4, borderRadius: 1, backgroundColor: '#FFFFFF' },
  shortRule: { width: 8 },
});
