import { StyleSheet, Text, View } from 'react-native';
import { palette, typography } from './planner-ui';

export function ProcedureStep({ step, index }: { step: string; index: number }) {
  return <View style={styles.row}>
    <Text style={styles.number}>{String(index + 1).padStart(2, '0')}</Text><Text style={styles.text}>{step}</Text>
  </View>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'baseline', gap: 10 },
  // Equal paragraph metrics + tabular, right-aligned digits share the first text baseline on both OSs.
  number: { ...typography.body, width: 28, flexShrink: 0, textAlign: 'right', fontVariant: ['tabular-nums'], includeFontPadding: false, color: palette.accent, fontWeight: '700' },
  text: { ...typography.body, flex: 1, includeFontPadding: false, color: palette.ink },
});
