import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, StatusBadge, palette, typography } from '@/components/planner-ui';
import type { ChoreDefinition, ChoreScheduleEntry } from '@/domain/chores/types';
import { formatJapaneseDate } from '@/domain/scheduling/local-date';

export function ChoreScheduleCard({
  entry,
  chore,
  onComplete,
  onOpen,
}: {
  entry: ChoreScheduleEntry;
  chore: ChoreDefinition;
  onComplete?: () => void;
  onOpen: () => void;
}) {
  const dateLabel = entry.windowStart === entry.windowEnd
    ? formatJapaneseDate(entry.windowStart, { weekday: true })
    : `${formatJapaneseDate(entry.windowStart)}〜${formatJapaneseDate(entry.windowEnd)}`;

  return (
    <Card style={styles.card}>
      <View style={styles.topRow}>
        <View style={styles.copy}>
          <Text style={styles.category}>{chore.category}{chore.estimatedMinutes ? ` · 約${chore.estimatedMinutes}分` : ''}</Text>
          <Text style={styles.name}>{chore.name}</Text>
        </View>
        <StatusBadge status={entry.status} />
      </View>
      <Pressable accessibilityRole="button" onPress={onOpen} style={styles.dateRow}>
        <Text style={styles.dateIcon}>◷</Text>
        <Text style={styles.date}>{dateLabel}</Text>
      </Pressable>
      {entry.status === 'overdue' && entry.overdueDays ? (
        <Text style={styles.overdue}>推奨期間を{entry.overdueDays}日過ぎています{entry.overdueCycles ? ` · ${entry.overdueCycles}周期分` : ''}</Text>
      ) : null}
      <View style={styles.actions}>
        <AppButton title="手順を見る" onPress={onOpen} variant="secondary" compact />
        {onComplete ? <AppButton title="完了" onPress={onComplete} compact /> : null}
      </View>
    </Card>
  );
}

const styles = StyleSheet.create({
  card: { gap: 10 },
  topRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between', gap: 10 },
  copy: { flex: 1, gap: 4 },
  category: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  name: { ...typography.body, color: palette.ink, fontWeight: '700' },
  dateRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  dateIcon: { color: palette.accent, fontSize: 17, fontWeight: '700' },
  date: { ...typography.label, color: palette.ink, fontWeight: '600' },
  overdue: { ...typography.caption, color: palette.warning, fontWeight: '600' },
  actions: { flexDirection: 'row', justifyContent: 'flex-end', gap: 8, marginTop: 2 },
});
