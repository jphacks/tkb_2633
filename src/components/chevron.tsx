import { StyleSheet, View } from 'react-native';
import { palette } from './planner-colors';

/** Stroke geometry avoids the different font metrics of >, › and ⌄. */
export function Chevron({ direction = 'right', color = palette.accent }: { direction?: 'left' | 'right' | 'up' | 'down'; color?: string }) {
  return <View aria-hidden style={styles.slot}><View style={[styles.stroke, { borderColor: color, transform: [{ rotate: `${{ right: -45, down: 45, left: 135, up: 225 }[direction]}deg` }] }]} /></View>;
}
const styles = StyleSheet.create({
  slot: { width: 22, height: 26, alignItems: 'center', justifyContent: 'center', flexShrink: 0 },
  stroke: { width: 9, height: 9, borderRightWidth: 2, borderBottomWidth: 2, borderColor: palette.accent },
});
