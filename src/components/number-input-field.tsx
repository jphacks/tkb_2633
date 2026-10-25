import { StyleSheet, Text, TextInput, View } from 'react-native';
import type { TextInputProps } from 'react-native';

import { palette, typography } from './planner-ui';

/** Single-line numeric controls use native font metrics, not paragraph line spacing. */
export function NumberInputField({ prefix, suffix = '日', ...props }: Omit<TextInputProps, 'style'> & { prefix?: string; suffix?: string }) {
  return <View style={styles.field}>
    <View style={styles.unitSlot} aria-hidden><Text style={styles.unit}>{prefix ?? ''}</Text></View>
    <TextInput {...props} keyboardType="number-pad" underlineColorAndroid="transparent" style={styles.input} />
    <View style={styles.unitSlot} aria-hidden><Text style={styles.unit}>{suffix}</Text></View>
  </View>;
}

const styles = StyleSheet.create({
  field: { minHeight: 46, flexDirection: 'row', alignItems: 'center', borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, paddingHorizontal: 8, backgroundColor: palette.background },
  // Equal unit slots keep the number horizontally centered, including fields without ±.
  unitSlot: { width: 18, alignItems: 'center', justifyContent: 'center' },
  unit: { fontSize: typography.caption.fontSize, color: palette.muted },
  input: { fontSize: typography.control.fontSize, color: palette.ink, fontWeight: '700', width: 56,
    minHeight: 44, padding: 0, textAlign: 'center', textAlignVertical: 'center', includeFontPadding: false },
});
