import { Pressable, StyleSheet, Text, View } from 'react-native';

import { palette, typography } from '@/components/planner-ui';
import type { WasteCollectionOccurrence } from '@/features/waste/contracts';

/** The fixed 28pt trailing column shares its center with TaskCheckboxRow. */
export function WasteOccurrenceCard({ occurrence, compact = false, hidden = false, busy = false, onToggle }: {
  occurrence: WasteCollectionOccurrence;
  compact?: boolean;
  hidden?: boolean;
  busy?: boolean;
  onToggle: () => void;
}) {
  return (
    <View style={[styles.row, compact && styles.compactRow]}>
      <View style={styles.copy}>
        <Text style={[styles.name, compact && styles.compactName]}>{occurrence.label}</Text>
        {!compact ? <Text style={styles.caption}>ゴミ出し</Text> : null}
      </View>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`${occurrence.label}の${occurrence.date}のゴミ出しを${hidden ? '再表示' : '非表示'}`}
        accessibilityState={{ checked: hidden, disabled: busy }}
        disabled={busy}
        onPress={onToggle}
        style={styles.action}>
        {compact ? <Text style={styles.caption}>ゴミ出し非表示</Text> : null}
        <View style={styles.checkboxColumn}>
          <View style={[styles.checkbox, compact && styles.compactCheckbox, hidden && styles.checked]}>
            {hidden ? <Text style={styles.checkmark}>✓</Text> : null}
          </View>
        </View>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 72, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 12 },
  compactRow: { minHeight: 56, paddingVertical: 5 },
  copy: { flex: 1, gap: 4 },
  name: { ...typography.body, color: palette.ink, fontWeight: '600' },
  compactName: { ...typography.label },
  caption: { ...typography.caption, color: palette.muted },
  action: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8 },
  checkboxColumn: { width: 28, alignItems: 'center' },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: '#C7D0E1', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  compactCheckbox: { width: 24, height: 24, borderRadius: 7 },
  checked: { borderColor: palette.accent, backgroundColor: palette.accent },
  checkmark: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
