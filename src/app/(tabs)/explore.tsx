import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { addDays, formatJapaneseDate, localDateFromDate, localDateFromISODateTime, monthDates, parseLocalDate, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore } from '@/platform/storage/repository';

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

export default function CalendarScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const today = localDateFromDate(new Date());
  const [month, setMonth] = useState(() => ({ year: new Date().getFullYear(), monthIndex: new Date().getMonth() }));
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());

  if (loading || !snapshot) return <Page><ScreenHeading eyebrow="SCHEDULE" title="カレンダー" description="予定を読み込んでいます。" /></Page>;

  const dates = monthDates(month.year, month.monthIndex);
  const leadingCells = weekdayOf(dates[0]) % 7;
  const gridStart = addDays(dates[0], -leadingCells);
  const weekCount = Math.ceil((leadingCells + dates.length) / 7);
  const cells = Array.from({ length: weekCount * 7 }, (_, index) => addDays(gridStart, index));
  const visibleEntries = snapshot.scheduleEntries.filter((entry) =>
    entry.windowEnd >= dates[0] && entry.windowStart <= dates[dates.length - 1],
  );
  const entriesOnDate = (date: LocalDate) => visibleEntries.filter((entry) => date >= entry.windowStart && date <= entry.windowEnd);
  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const completedChoreIds = new Set(snapshot.completions
    .filter((completion) => completion.outcome === 'completed' && localDateFromISODateTime(completion.completedAt) === selectedDate)
    .map((completion) => completion.choreId));
  const selectedEntries = entriesOnDate(selectedDate).sort((left, right) =>
    Number(completedChoreIds.has(left.choreId)) - Number(completedChoreIds.has(right.choreId))
    || left.suggestedDate.localeCompare(right.suggestedDate),
  );
  const completedOnlyChores = [...completedChoreIds]
    .filter((choreId) => !selectedEntries.some((entry) => entry.choreId === choreId))
    .map((choreId) => choresById.get(choreId))
    .filter((chore) => chore !== undefined);

  const moveMonth = (offset: number) => {
    const next = new Date(Date.UTC(month.year, month.monthIndex + offset, 1));
    const nextYear = next.getUTCFullYear();
    const nextMonth = next.getUTCMonth();
    setMonth({ year: nextYear, monthIndex: nextMonth });
    setSelectedDate(`${nextYear}-${String(nextMonth + 1).padStart(2, '0')}-01` as LocalDate);
  };

  const finish = async (entryId: string) => {
    const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === entryId);
    if (!entry || completingIds.has(entryId)) return;
    setCompletingIds((current) => new Set(current).add(entryId));
    try {
      await completeChore(database, entry);
      await refresh();
    } finally {
      setCompletingIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  };

  return (
    <Page>
      <ScreenHeading title="カレンダー" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
      <Card style={styles.calendarCard}>
        <View style={styles.monthHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="前の月" onPress={() => moveMonth(-1)} style={styles.monthArrow}><Text style={styles.arrowText}>‹</Text></Pressable>
          <Text style={styles.monthTitle}>{month.year}年{month.monthIndex + 1}月</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="次の月" onPress={() => moveMonth(1)} style={styles.monthArrow}><Text style={styles.arrowText}>›</Text></Pressable>
        </View>
        <View style={styles.weekRow}>
          {weekdayLabels.map((label, index) => <Text key={label} style={[styles.weekday, (index === 0 || index === 6) && styles.weekend]}>{label}</Text>)}
        </View>
        <View style={styles.grid}>
          {cells.map((date) => {
            const dayEntries = entriesOnDate(date);
            const selected = date === selectedDate;
            const isToday = date === today;
            const inMonth = date.slice(0, 7) === `${month.year}-${String(month.monthIndex + 1).padStart(2, '0')}`;
            const weekDay = weekdayOf(date);
            return (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityLabel={`${formatJapaneseDate(date)}、家事${dayEntries.length}件`}
                accessibilityState={{ selected }}
                onPress={() => {
                  setSelectedDate(date);
                  if (!inMonth) {
                    const tapped = parseLocalDate(date);
                    setMonth({ year: tapped.getUTCFullYear(), monthIndex: tapped.getUTCMonth() });
                  }
                }}
                style={[styles.dayCell, selected && styles.selectedDay, isToday && !selected && styles.todayDay]}>
                <Text style={[styles.dayNumber, !inMonth && styles.outsideMonth, (weekDay === 6 || weekDay === 7) && styles.weekendNumber, selected && styles.selectedDayNumber]}>{Number(date.slice(-2))}</Text>
                <View style={styles.dots}>
                  {dayEntries.slice(0, 3).map((entry) => (
                    <View key={entry.id} style={[styles.dot, entry.status === 'overdue' ? styles.dotOverdue : entry.status === 'inWindow' ? styles.dotInWindow : null]} />
                  ))}
                  {dayEntries.length > 3 ? <Text style={styles.moreCount}>+{dayEntries.length - 3}</Text> : null}
                </View>
              </Pressable>
            );
          })}
        </View>
      </Card>

      <SectionHeading title={formatJapaneseDate(selectedDate, { weekday: true })} trailing={<Text style={styles.smallCount}>{selectedEntries.length + completedOnlyChores.length}件・{completedChoreIds.size}件完了</Text>} />
      {selectedEntries.length + completedOnlyChores.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>この日の予定はありません</Text><Text style={styles.emptyText}>別の日を選ぶか、家事一覧で予定を確認できます。</Text></Card>
      ) : selectedEntries.map((entry) => {
        const chore = choresById.get(entry.choreId);
        if (!chore) return null;
        return (
          <TaskCheckboxRow
            key={entry.id}
            chore={chore}
            completed={completedChoreIds.has(chore.id)}
            onOpen={() => router.push({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })}
            onToggle={() => void finish(entry.id)}
          />
        );
      })}

      {completedOnlyChores.map((chore) => (
        <TaskCheckboxRow key={`completed-${chore.id}`} chore={chore} completed onOpen={() => router.push({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })} />
      ))}

      {snapshot.scheduleEntries.some((entry) => entry.status === 'overdue') ? (
        <>
          <SectionHeading title="期間を過ぎた家事" />
          {snapshot.scheduleEntries.filter((entry) => entry.status === 'overdue').slice(0, 3).map((entry) => {
            const chore = choresById.get(entry.choreId);
            if (!chore) return null;
            return (
              <TaskCheckboxRow
                key={`overdue-${entry.id}`}
                chore={chore}
                onToggle={() => void finish(entry.id)}
                onOpen={() => router.push({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })}
              />
            );
          })}
        </>
      ) : null}
      <AppButton title="家事一覧へ" onPress={() => router.push('/chores')} variant="secondary" />
    </Page>
  );
}

const styles = StyleSheet.create({
  calendarCard: { paddingHorizontal: 12, paddingTop: 12, paddingBottom: 14, gap: 10 },
  monthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthArrow: { width: 40, height: 40, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: palette.accentSoft },
  arrowText: { color: palette.accent, fontSize: 30, lineHeight: 33, fontWeight: '500' },
  monthTitle: { color: palette.ink, fontSize: 18, fontWeight: '700' },
  weekRow: { flexDirection: 'row' },
  weekday: { flex: 1, textAlign: 'center', color: palette.muted, fontSize: 11, fontWeight: '700', paddingVertical: 4 },
  weekend: { color: palette.warning },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  dayCell: { width: '14.2857%', height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'flex-start', paddingTop: 3, gap: 3 },
  selectedDay: { backgroundColor: palette.accent },
  todayDay: { backgroundColor: palette.accentSoft },
  dayNumber: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  outsideMonth: { color: '#B7BED0' },
  weekendNumber: { color: '#78819A' },
  selectedDayNumber: { color: '#FFFFFF' },
  dots: { minHeight: 8, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 3 },
  dot: { width: 5, height: 5, borderRadius: 3, backgroundColor: palette.accent },
  dotInWindow: { backgroundColor: '#86A78F' },
  dotOverdue: { backgroundColor: palette.warning },
  moreCount: { color: palette.muted, fontSize: 8, lineHeight: 9 },
  smallCount: { color: palette.muted, fontSize: 12 },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  emptyText: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
});
