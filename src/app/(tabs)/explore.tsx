import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { CalendarTaskCountIndicator } from '@/components/calendar-task-count-indicator';
import { PlannerLoadState } from '@/components/planner-load-state';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { completionMatchesEntry, completionPeriod } from '@/domain/scheduling/completion-matching';
import { orderDateTasks, recommendedChoreCounts, selectDateTasks } from '@/domain/scheduling/date-tasks';
import { addDays, daysBetween, formatJapaneseDate, localDateFromDate, monthDates, parseLocalDate, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore, undoCompletedChore } from '@/platform/storage/repository';

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

export default function CalendarScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const today = localDateFromDate(new Date());
  const [month, setMonth] = useState(() => ({ year: new Date().getFullYear(), monthIndex: new Date().getMonth() }));
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today);
  const [periodsExpanded, setPeriodsExpanded] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);

  if (loading || !snapshot) return <PlannerLoadState title="カレンダー" message="予定を読み込んでいます。" error={error} retry={refresh} />;

  const dates = monthDates(month.year, month.monthIndex);
  const leadingCells = weekdayOf(dates[0]) % 7;
  const gridStart = addDays(dates[0], -leadingCells);
  const weekCount = Math.ceil((leadingCells + dates.length) / 7);
  const cells = Array.from({ length: weekCount * 7 }, (_, index) => addDays(gridStart, index));
  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const recommendedCountsByDate = recommendedChoreCounts(snapshot.scheduleEntries, snapshot.completions);
  const selectedTasks = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, selectedDate), selectedDate, snapshot.chores);
  const selectedChoreIds = new Set(selectedTasks.map((task) => task.choreId));
  const overdueTasks = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3)
    .filter((task) => task.entry?.status === 'overdue' && !task.completed && !selectedChoreIds.has(task.choreId)), today, snapshot.chores);
  const completedCount = selectedTasks.filter((task) => task.completed).length;
  const periodRows = selectedTasks.flatMap((task) => {
    const chore = choresById.get(task.choreId);
    const period = task.entry
      ? { start: task.entry.windowStart, end: task.entry.windowEnd }
      : completionPeriod(task.completion!);
    return chore ? [{
      id: task.id,
      name: chore.name,
      ...period,
      completed: task.completed,
    }] : [];
  });
  periodRows.sort((left, right) => left.start.localeCompare(right.start) || left.name.localeCompare(right.name));
  const selectedWeekStart = addDays(selectedDate, -(weekdayOf(selectedDate) % 7));
  const selectedWeekEnd = addDays(selectedWeekStart, 6);
  const selectedWeekDates = Array.from({ length: 7 }, (_, index) => addDays(selectedWeekStart, index));

  const moveMonth = (offset: number) => {
    const next = new Date(Date.UTC(month.year, month.monthIndex + offset, 1));
    const nextYear = next.getUTCFullYear();
    const nextMonth = next.getUTCMonth();
    setMonth({ year: nextYear, monthIndex: nextMonth });
  };

  const toggleEntry = async (entryId: string) => {
    const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === entryId);
    if (!entry || completingIds.has(entryId)) return;
    setCompletingIds((current) => new Set(current).add(entryId));
    setActionError(null);
    try {
      const completion = snapshot.completions.find((item) => completionMatchesEntry(item, entry));
      if (completion) await undoCompletedChore(database, completion.id);
      else await completeChore(database, entry);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '家事の完了状態を保存できませんでした。');
    } finally {
      setCompletingIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  };

  const undoCompletion = async (completionId: string) => {
    if (completingIds.has(completionId)) return;
    setCompletingIds((current) => new Set(current).add(completionId));
    setActionError(null);
    try {
      await undoCompletedChore(database, completionId);
      await refresh();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '完了を取り消せませんでした。');
    } finally {
      setCompletingIds((current) => {
        const next = new Set(current);
        next.delete(completionId);
        return next;
      });
    }
  };

  return (
    <Page>
      <ScreenHeading title="カレンダー" />
      {error || actionError ? <Card><Text style={styles.error}>{actionError ?? error}</Text></Card> : null}
      <Pressable accessible={false} onPress={() => setPeriodsExpanded((expanded) => !expanded)}>
      <Card style={styles.calendarCard}>
        <View style={styles.monthHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="前の月" onPress={(event) => { event.stopPropagation(); moveMonth(-1); }} style={styles.monthArrow}><Text style={styles.arrowText}>‹</Text></Pressable>
          <Text style={styles.monthTitle}>{month.year}年{month.monthIndex + 1}月</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="次の月" onPress={(event) => { event.stopPropagation(); moveMonth(1); }} style={styles.monthArrow}><Text style={styles.arrowText}>›</Text></Pressable>
        </View>
        <View style={styles.weekRow}>
          {weekdayLabels.map((label, index) => <Text key={label} style={[styles.weekday, (index === 0 || index === 6) && styles.weekend]}>{label}</Text>)}
        </View>
        <View style={styles.grid}>
          {cells.map((date) => {
            const recommendedCount = recommendedCountsByDate.get(date) ?? 0;
            const selected = date === selectedDate;
            const isToday = date === today;
            const inMonth = date.slice(0, 7) === `${month.year}-${String(month.monthIndex + 1).padStart(2, '0')}`;
            const weekDay = weekdayOf(date);
            return (
              <Pressable
                key={date}
                accessibilityRole="button"
                accessibilityLabel={`${formatJapaneseDate(date)}、推奨日の未完了の家事${recommendedCount}件`}
                accessibilityState={{ selected }}
                onPress={(event) => {
                  event.stopPropagation();
                  setSelectedDate(date);
                  if (!inMonth) {
                    const tapped = parseLocalDate(date);
                    setMonth({ year: tapped.getUTCFullYear(), monthIndex: tapped.getUTCMonth() });
                  }
                }}
                style={[styles.dayCell, selected && styles.selectedDay, isToday && !selected && styles.todayDay]}>
                <Text style={[styles.dayNumber, !inMonth && styles.outsideMonth, (weekDay === 6 || weekDay === 7) && styles.weekendNumber, selected && styles.selectedDayNumber]}>{Number(date.slice(-2))}</Text>
                <CalendarTaskCountIndicator count={recommendedCount} colors={snapshot.settings.calendarCountColors} mode={snapshot.settings.calendarCountDisplayMode} selected={selected} />
              </Pressable>
            );
          })}
        </View>
        {periodsExpanded ? (
          <View style={styles.periodPanel}>
            <View style={styles.periodPanelHeader}>
              <Text style={styles.periodPanelTitle}>{formatJapaneseDate(selectedDate)}を含む実施期間</Text>
              <Pressable accessibilityRole="button" onPress={(event) => { event.stopPropagation(); setPeriodsExpanded(false); }}>
                <Text style={styles.periodPanelClose}>閉じる</Text>
              </Pressable>
            </View>
            <View style={styles.periodDateRow}>
              {selectedWeekDates.map((date) => (
                <Text key={date} style={[styles.periodDate, date === selectedDate && styles.periodDateSelected]}>{Number(date.slice(-2))}</Text>
              ))}
            </View>
            {periodRows.length ? periodRows.map((period) => {
              const clippedStart = period.start < selectedWeekStart ? selectedWeekStart : period.start;
              const clippedEnd = period.end > selectedWeekEnd ? selectedWeekEnd : period.end;
              const left = daysBetween(selectedWeekStart, clippedStart) / 7 * 100;
              const width = Math.max(0, daysBetween(clippedStart, clippedEnd) + 1) / 7 * 100;
              const rangeLabel = period.start === period.end
                ? formatJapaneseDate(period.start)
                : `${formatJapaneseDate(period.start)}〜${formatJapaneseDate(period.end)}`;
              return (
                <View key={period.id} style={styles.periodRow} accessibilityLabel={`${period.name}、${rangeLabel}`}>
                  <Text style={[styles.periodName, period.completed && styles.periodCompletedText]} numberOfLines={1}>{period.name}</Text>
                  <View style={styles.periodTrack}>
                    <View style={[styles.periodBar, period.completed && styles.periodBarCompleted, { left: `${left}%`, width: `${width}%` }]} />
                  </View>
                  <Text style={styles.periodRange}>{rangeLabel}</Text>
                </View>
              );
            }) : (
              <Text style={styles.noPeriods}>この日に重なる実施期間はありません。</Text>
            )}
          </View>
        ) : null}
      </Card>
      </Pressable>

      <SectionHeading title={formatJapaneseDate(selectedDate, { weekday: true })} trailing={<Text style={styles.smallCount}>{selectedTasks.length}件・{completedCount}件完了</Text>} />
      {selectedTasks.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>この日の予定はありません</Text><Text style={styles.emptyText}>別の日を選ぶか、家事一覧で予定を確認できます。</Text></Card>
      ) : selectedTasks.map((task) => {
        const chore = choresById.get(task.choreId);
        if (!chore) return null;
        const { entry, completion } = task;
        return (
          <TaskCheckboxRow
            key={`${chore.id}:${selectedDate}`}
            chore={chore}
            completed={task.completed}
            deemphasized={task.suggestedDate !== selectedDate}
            onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'calendar' } })}
            onToggle={task.completed
              ? completion && !completingIds.has(completion.id) ? () => void undoCompletion(completion.id) : undefined
              : entry && !completingIds.has(entry.id) ? () => void toggleEntry(entry.id) : undefined}
          />
        );
      })}

      {overdueTasks.length ? (
        <>
          <SectionHeading title="期間を過ぎた家事" />
          {overdueTasks.slice(0, 3).map((task) => {
            const entry = task.entry!;
            const chore = choresById.get(entry.choreId);
            if (!chore) return null;
            return (
              <TaskCheckboxRow
                key={`overdue-${entry.choreId}`}
                chore={chore}
                deemphasized
                onToggle={!completingIds.has(entry.id) ? () => void toggleEntry(entry.id) : undefined}
                onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'calendar' } })}
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
  periodPanel: { gap: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingTop: 11 },
  periodPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  periodPanelTitle: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  periodPanelClose: { color: palette.accent, fontSize: 12, fontWeight: '700' },
  periodDateRow: { flexDirection: 'row', paddingBottom: 1 },
  periodDate: { width: '14.2857%', textAlign: 'center', color: palette.muted, fontSize: 10, fontWeight: '600' },
  periodDateSelected: { color: palette.accent, fontWeight: '800' },
  periodRow: { gap: 3 },
  periodName: { color: palette.ink, fontSize: 12, fontWeight: '700' },
  periodCompletedText: { color: '#858B9E', textDecorationLine: 'line-through' },
  periodTrack: { height: 8, borderRadius: 4, backgroundColor: '#EFF2F7', overflow: 'hidden' },
  periodBar: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4, backgroundColor: palette.accent },
  periodBarCompleted: { backgroundColor: '#AAB1C1' },
  periodRange: { color: palette.muted, fontSize: 10 },
  noPeriods: { color: palette.muted, fontSize: 12, paddingVertical: 4 },
  smallCount: { color: palette.muted, fontSize: 12 },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  emptyText: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
});
