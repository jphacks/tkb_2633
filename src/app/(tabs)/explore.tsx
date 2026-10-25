import { router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';
import { CalendarTaskCountIndicator } from '@/components/calendar-task-count-indicator';
import { PlannerLoadState } from '@/components/planner-load-state';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { WasteOccurrenceCard } from '@/components/waste-occurrence-card';
import { completionMatchesEntry, completionPeriod } from '@/domain/scheduling/completion-matching';
import { orderDateTasks, recommendedChoreCounts, selectDateTasks } from '@/domain/scheduling/date-tasks';
import { addDays, daysBetween, formatJapaneseDate, localDateFromDate, monthDates, parseLocalDate, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore, undoCompletedChore } from '@/platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';
import { wasteCalendarLabels } from '@/features/waste/calendar-labels';
import { calendarWasteLabel, wasteTypeColor } from '@/features/waste/type-appearance';
import { generateWasteCollectionDates } from '@/features/waste/weekly-scheduler';
import { useWasteOccurrenceToggle } from '@/features/waste/use-waste-occurrence-toggle';

const weekdayLabels = ['日', '月', '火', '水', '木', '金', '土'];

export default function CalendarScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const today = localDateFromDate(new Date());
  const [month, setMonth] = useState(() => ({ year: new Date().getFullYear(), monthIndex: new Date().getMonth() }));
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today);
  const [periodsExpanded, setPeriodsExpanded] = useState(false);
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const wasteVisibility = useWasteOccurrenceToggle(database, refresh);

  if (loading || !snapshot) return <PlannerLoadState title="カレンダー" message="予定を読み込んでいます。" error={error} retry={refresh} />;

  const dates = monthDates(month.year, month.monthIndex);
  const leadingCells = weekdayOf(dates[0]) % 7;
  const gridStart = addDays(dates[0], -leadingCells);
  const weekCount = Math.ceil((leadingCells + dates.length) / 7);
  const cells = Array.from({ length: weekCount * 7 }, (_, index) => addDays(gridStart, index));
  const { weeklyByColumn, byDate: wasteByDate, hiddenWeeklyByDate } = wasteCalendarLabels(snapshot.wasteSchedules, gridStart, cells[cells.length - 1], snapshot.hiddenWasteOccurrenceKeys);
  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const recommendedCountsByDate = recommendedChoreCounts(snapshot.scheduleEntries, snapshot.completions);
  const selectedTasks = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, selectedDate, 0, snapshot.chores), selectedDate, snapshot.chores);
  const selectedChoreIds = new Set(selectedTasks.map((task) => task.choreId));
  const overdueTasks = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores)
    .filter((task) => task.entry?.status === 'overdue' && !task.completed && !selectedChoreIds.has(task.choreId)), today, snapshot.chores);
  const completedCount = selectedTasks.filter((task) => task.completed).length;
  // Include checked occurrences here so hiding from home can always be undone on its date.
  const selectedWaste = snapshot.wasteSchedules.flatMap((schedule) => generateWasteCollectionDates(schedule, selectedDate, selectedDate));
  const hiddenWasteKeys = new Set(snapshot.hiddenWasteOccurrenceKeys);
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
      if (completion) { if (await undoCompletedChore(database, completion.id)) syncGoogleTasksAfterLocalCompletion(database); }
      else if (await completeChore(database, entry)) syncGoogleTasksAfterLocalCompletion(database);
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
      if (await undoCompletedChore(database, completionId)) syncGoogleTasksAfterLocalCompletion(database);
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
    <Page contentStyle={styles.calendarPage}>
      <ScreenHeading title="カレンダー" />
      {error || actionError || wasteVisibility.error ? <Card><Text style={styles.error}>{wasteVisibility.error ?? actionError ?? error}</Text></Card> : null}
      <Pressable accessible={false} onPress={() => setPeriodsExpanded((expanded) => !expanded)}>
      <Card style={styles.calendarCard}>
        <View style={styles.monthHeader}>
          <Pressable accessibilityRole="button" accessibilityLabel="前の月" onPress={(event) => { event.stopPropagation(); moveMonth(-1); }} style={styles.monthArrow}><Text style={styles.arrowText}>‹</Text></Pressable>
          <Text style={styles.monthTitle}>{month.year}年{month.monthIndex + 1}月</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="次の月" onPress={(event) => { event.stopPropagation(); moveMonth(1); }} style={styles.monthArrow}><Text style={styles.arrowText}>›</Text></Pressable>
        </View>
        {!cells.includes(selectedDate) ? <View style={styles.retainedSelectionRow}>
          <Text style={styles.retainedSelectionText}>{formatJapaneseDate(selectedDate, { weekday: true })}の予定を表示中</Text>
        </View> : null}
        <View style={styles.weekRow}>
          {weekdayLabels.map((label, index) => <View key={label} style={styles.weekdaySlot}>
            <View accessibilityLabel={`${label}曜日${weeklyByColumn[index].length ? `、${weeklyByColumn[index].join('・')}` : ''}`}
              style={[styles.weekdayPill, weeklyByColumn[index].length > 0 && styles.wasteOutline,
                weeklyByColumn[index].length > 0 && { borderColor: wasteTypeColor(weeklyByColumn[index][0]) }]}>
              <Text style={[styles.weekday, (index === 0 || index === 6) && styles.weekend]}>{label}</Text>
              {weeklyByColumn[index].map((name) => <WasteCalendarName key={name} name={name} />)}
            </View>
          </View>)}
        </View>
        <View style={styles.grid}>
          {Array.from({ length: weekCount }, (_, week) => <View key={cells[week * 7]} style={styles.calendarWeek}>
          {cells.slice(week * 7, week * 7 + 7).map((date) => {
            const recommendedCount = recommendedCountsByDate.get(date) ?? 0;
            const wasteLabels = wasteByDate.get(date) ?? [];
            const hiddenWeeklyLabels = hiddenWeeklyByDate.get(date) ?? [];
            const selected = date === selectedDate;
            const isToday = date === today;
            const inMonth = date.slice(0, 7) === `${month.year}-${String(month.monthIndex + 1).padStart(2, '0')}`;
            const weekDay = weekdayOf(date);
            return (
              <View key={date} style={styles.daySlot}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`${formatJapaneseDate(date)}、推奨日の未完了の家事${recommendedCount}件${wasteLabels.length ? `、${wasteLabels.join('・')}` : ''}${hiddenWeeklyLabels.length ? `、非表示の収集：${hiddenWeeklyLabels.join('・')}` : ''}`}
                accessibilityState={{ selected }}
                hitSlop={{ top: 4, bottom: 4 }}
                onPress={(event) => {
                  event.stopPropagation();
                  setSelectedDate(date);
                  if (!inMonth) {
                    const tapped = parseLocalDate(date);
                    setMonth({ year: tapped.getUTCFullYear(), monthIndex: tapped.getUTCMonth() });
                  }
                }}
                style={[styles.dayCell, selected && styles.selectedDay, isToday && !selected && styles.todayDay,
                  wasteLabels.length > 0 && styles.wasteOutline,
                  wasteLabels.length > 0 && { borderColor: wasteTypeColor(wasteLabels[0]) },
                  hiddenWeeklyLabels.length > 0 && styles.hiddenWeeklyDay,
                  selected && (wasteLabels.length > 0 || hiddenWeeklyLabels.length > 0) && styles.selectedOutlinedDay,
                  isToday && !selected && wasteLabels.length > 0 && styles.todayDay]}>
                <Text style={[styles.dayNumber, !inMonth && styles.outsideMonth, (weekDay === 6 || weekDay === 7) && styles.weekendNumber,
                  selected && styles.selectedDayNumber,
                  selected && (wasteLabels.length > 0 || hiddenWeeklyLabels.length > 0) && styles.outlinedDayNumber]}>{Number(date.slice(-2))}</Text>
                {wasteLabels.map((name) => <WasteCalendarName key={name} name={name} />)}
                {recommendedCount > 0 ? <CalendarTaskCountIndicator count={recommendedCount} colors={snapshot.settings.calendarCountColors} mode={snapshot.settings.calendarCountDisplayMode} selected={selected} /> : null}
              </Pressable>
              </View>
            );
          })}
          </View>)}
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
      {selectedWaste.map((item) => {
        const key = `${item.scheduleId}:${item.date}`;
        const hidden = hiddenWasteKeys.has(key);
        return <WasteOccurrenceCard key={key} occurrence={item} compact hidden={hidden}
          busy={wasteVisibility.busyKeys.has(key)} onToggle={() => void wasteVisibility.toggle(item, hidden)} />;
      })}
      {selectedTasks.length === 0 && selectedWaste.length === 0 ? (
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

function WasteCalendarName({ name }: { name: string }) {
  return <Text numberOfLines={2} style={[styles.wasteLabel, { color: wasteTypeColor(name) }]}>{calendarWasteLabel(name)}</Text>;
}

const styles = StyleSheet.create({
  calendarPage: { gap: 10, paddingTop: 12 },
  calendarCard: { paddingHorizontal: 6, paddingTop: 8, paddingBottom: 8, gap: 6 },
  monthHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  monthArrow: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', borderRadius: 12, backgroundColor: palette.accentSoft },
  arrowText: { color: palette.accent, fontSize: 30, lineHeight: 33, fontWeight: '500' },
  monthTitle: { ...typography.section, color: palette.ink, fontWeight: '700' },
  weekRow: { flexDirection: 'row' },
  weekday: { textAlign: 'center', color: palette.muted, ...typography.label, fontWeight: '700' },
  weekdaySlot: { flex: 1, paddingHorizontal: 1 },
  weekdayPill: { minHeight: 32, justifyContent: 'flex-start', alignItems: 'center', borderRadius: 10, paddingHorizontal: 0, paddingVertical: 2, gap: 1, borderWidth: 1.5, borderColor: 'transparent' },
  wasteOutline: { borderWidth: 1.5, backgroundColor: '#FFFFFF' },
  wasteLabel: { width: '100%', ...typography.calendarLabel, fontWeight: '700', textAlign: 'center' },
  hiddenWeeklyDay: { borderColor: '#929BAA', backgroundColor: '#F3F4F6', borderWidth: 1.5 },
  selectedOutlinedDay: { backgroundColor: palette.accentSoft, borderWidth: 2.5 },
  outlinedDayNumber: { color: '#205B79' },
  retainedSelectionRow: { alignItems: 'center', paddingVertical: 4 },
  retainedSelectionText: { ...typography.caption, color: palette.accent, fontWeight: '700', textAlign: 'center' },
  weekend: { color: palette.warning },
  grid: { gap: 0 },
  calendarWeek: { flexDirection: 'row', alignItems: 'stretch' },
  daySlot: { flex: 1, paddingHorizontal: 1 },
  dayCell: { flex: 1, width: '100%', minHeight: 36, borderRadius: 10, alignItems: 'center', justifyContent: 'flex-start', paddingVertical: 2, borderWidth: 1.5, borderColor: 'transparent', gap: 1 },
  selectedDay: { backgroundColor: palette.accent },
  todayDay: { backgroundColor: palette.accentSoft },
  dayNumber: { color: palette.ink, ...typography.calendarDate, fontWeight: '600' },
  outsideMonth: { color: '#B7BED0' },
  weekendNumber: { color: '#78819A' },
  selectedDayNumber: { color: '#FFFFFF' },
  periodPanel: { gap: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingTop: 11 },
  periodPanelHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  periodPanelTitle: { ...typography.label, color: palette.ink, fontWeight: '700', flex: 1 },
  periodPanelClose: { ...typography.label, color: palette.accent, fontWeight: '700' },
  periodDateRow: { flexDirection: 'row', paddingBottom: 1 },
  periodDate: { ...typography.caption, width: '14.2857%', textAlign: 'center', color: palette.muted, fontWeight: '600' },
  periodDateSelected: { color: palette.accent, fontWeight: '800' },
  periodRow: { gap: 3 },
  periodName: { ...typography.label, color: palette.ink, fontWeight: '700' },
  periodCompletedText: { color: '#858B9E', textDecorationLine: 'line-through' },
  periodTrack: { height: 8, borderRadius: 4, backgroundColor: '#EFF2F7', overflow: 'hidden' },
  periodBar: { position: 'absolute', top: 0, bottom: 0, borderRadius: 4, backgroundColor: palette.accent },
  periodBarCompleted: { backgroundColor: '#AAB1C1' },
  periodRange: { ...typography.caption, color: palette.muted },
  noPeriods: { ...typography.caption, color: palette.muted, paddingVertical: 4 },
  smallCount: { ...typography.caption, color: palette.muted },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyText: { ...typography.caption, color: palette.muted },
  error: { ...typography.label, color: palette.warning },
});
