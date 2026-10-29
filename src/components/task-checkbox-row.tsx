import { Pressable, StyleSheet, Text, View } from 'react-native';

import type { ChoreDefinition } from '@/domain/chores/types';
import { palette, typography } from '@/components/planner-ui';

export function TaskCheckboxRow({ chore, completed = false, deemphasized = false, source, early = false, urgent = false, onToggle, onOpen }: {
  chore: ChoreDefinition;
  completed?: boolean;
  deemphasized?: boolean;
  source?: 'personal' | 'shared' | 'instructed';
  early?: boolean;
  urgent?: boolean;
  onToggle?: () => void;
  onOpen: () => void;
}) {
  return (
    <View style={[styles.row, source && source !== 'personal' && styles.sharedRow, source === 'instructed' && styles.instructedRow,
      (deemphasized || early) && !completed && styles.deemphasizedRow, urgent && !completed && styles.urgentRow, completed && styles.completedRow]}>
      <Pressable accessibilityRole="button" accessibilityLabel={`${chore.name}の説明を開く`} onPress={onOpen} style={styles.copy}>
        <Text style={[styles.name, deemphasized && !completed && styles.deemphasizedText, completed && styles.completedText]}>{chore.name}</Text>
        {source || early || urgent || chore.category ? <Text style={[styles.category, completed && styles.completedCategory]}>
          {[source === 'instructed' ? '共有・日時指定' : source === 'shared' ? '共有' : source === 'personal' ? '個人' : '',
            early && !completed ? '推奨日前' : urgent && !completed ? '期限間近' : '', chore.category].filter(Boolean).join(' · ')}
        </Text> : null}
      </Pressable>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`${chore.name}を${completed ? '未完了に戻す' : '完了'}`}
        accessibilityState={{ checked: completed, disabled: !onToggle }}
        disabled={!onToggle}
        onPress={onToggle}
        hitSlop={8}
        style={[styles.checkbox, completed && styles.checkboxCompleted]}>
        {completed ? <Text style={styles.checkmark}>✓</Text> : null}
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { minHeight: 64, flexDirection: 'row', alignItems: 'center', gap: 14, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 15, paddingVertical: 9 },
  sharedRow: { borderLeftWidth: 3, borderLeftColor: '#7C8EC6' },
  instructedRow: { borderLeftColor: '#71629A', backgroundColor: '#FAF8FD' },
  urgentRow: { borderLeftWidth: 3, borderLeftColor: palette.gold },
  deemphasizedRow: { backgroundColor: '#FAFBFD', borderColor: '#E8ECF3' },
  completedRow: { backgroundColor: '#F0F1F5', borderColor: '#F0F1F5' },
  copy: { flex: 1, gap: 2, minHeight: 44, justifyContent: 'center' },
  name: { ...typography.subheading, color: palette.ink, fontWeight: '600' },
  category: { ...typography.caption, color: palette.muted },
  deemphasizedText: { color: '#727B91' },
  deemphasizedCategory: { color: '#949CAF' },
  completedText: { color: '#858B9E', textDecorationLine: 'line-through' },
  completedCategory: { color: '#858B9E' },
  checkbox: { width: 28, height: 28, borderRadius: 8, borderWidth: 1.5, borderColor: '#C7D0E1', backgroundColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  checkboxCompleted: { borderColor: palette.accent, backgroundColor: palette.accent },
  checkmark: { color: '#FFFFFF', fontSize: 16, fontWeight: '800', lineHeight: 20 },
});
