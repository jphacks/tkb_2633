import { Platform, StyleSheet, Switch, View } from 'react-native';
import type { SwitchProps } from 'react-native';

/** A fixed, centered touch slot keeps native switch drawings aligned with each row's text. */
export function SettingsSwitch({ style, ...props }: SwitchProps) {
  return <View pointerEvents="box-none" style={styles.slot}>
    <Switch trackColor={{ false: '#DCE2EB', true: '#83B9D4' }}
      thumbColor={Platform.OS === 'android' ? '#FFFFFF' : undefined} hitSlop={10} {...props} style={[styles.control, style]} />
  </View>;
}
const styles = StyleSheet.create({
  slot: { width: 56, height: 44, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  control: { alignSelf: 'center', transform: [{ scale: 0.9 }] },
});
