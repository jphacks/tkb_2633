import { Tabs, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition, SlideInLeft, SlideOutRight } from 'react-native-reanimated';

import { Card, Page, SectionHeading, palette } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import type { ChoreScheduleEntry } from '@/domain/chores/types';
import { addDays, formatJapaneseDate, localDateFromDate, localDateFromISODateTime, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore, setWasteOccurrenceHidden } from '@/platform/storage/repository';

type WeekScope = 'current' | 'next';
type UpcomingTaskRow = { id: string; choreId: string; completed: boolean; entry?: ChoreScheduleEntry };

export default function HomeScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [animatedCompletedChoreIds, setAnimatedCompletedChoreIds] = useState<Set<string>>(new Set());
  const [wasteMessage, setWasteMessage] = useState<string | null>(null);
  const [weekScope, setWeekScope] = useState<WeekScope>('current');
  const today = localDateFromDate(new Date());
  const thisWeekEnd = addDays(today, 7 - weekdayOf(today));
  const nextWeekStart = addDays(thisWeekEnd, 1);
  const nextWeekEnd = addDays(nextWeekStart, 6);
  const periodStart = weekScope === 'current' ? today : nextWeekStart;
  const periodEnd = weekScope === 'current' ? thisWeekEnd : nextWeekEnd;
  const upcomingByDate = useMemo(() => {
    const groups = new Map<LocalDate, UpcomingTaskRow[]>();
    const entries = snapshot?.scheduleEntries ?? [];
    const completions = snapshot?.completions ?? [];
    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const completionsByEntryId = new Map(completions
      .filter((completion) => completion.outcome === 'completed' && completion.scheduleEntryId)
      .map((completion) => [completion.scheduleEntryId!, completion]));
    const addedCompletionIds = new Set<string>();
    const addRow = (date: LocalDate, row: UpcomingTaskRow) => {
      const group = groups.get(date) ?? [];
      group.push(row);
      groups.set(date, group);
    };

    for (const entry of entries) {
      if (entry.status === 'overdue' || entry.suggestedDate <= today
        || entry.suggestedDate < periodStart || entry.suggestedDate > periodEnd) continue;
      const completion = completionsByEntryId.get(entry.id);
      if (completion) {
        const date = completion.scheduledDate ?? entry.suggestedDate;
        if (date >= periodStart && date <= periodEnd && date > today) {
          addRow(date, { id: `completed:${completion.id}`, choreId: completion.choreId, completed: true });
          addedCompletionIds.add(completion.id);
        }
        continue;
      }
      addRow(entry.suggestedDate, { id: entry.id, choreId: entry.choreId, completed: false, entry });
    }

    for (const completion of completions) {
      if (completion.outcome !== 'completed' || addedCompletionIds.has(completion.id)) continue;
      const matchingEntry = completion.scheduleEntryId ? entriesById.get(completion.scheduleEntryId) : undefined;
      const date = completion.scheduledDate ?? matchingEntry?.suggestedDate;
      if (!date || date <= today || date < periodStart || date > periodEnd) continue;
      addRow(date, { id: `completed:${completion.id}`, choreId: completion.choreId, completed: true });
    }
    for (const group of groups.values()) group.sort((left, right) => Number(left.completed) - Number(right.completed));
    return [...groups.entries()].sort(([left], [right]) => left.localeCompare(right));
  }, [periodEnd, periodStart, snapshot, today]);

  if (loading || !snapshot) {
    return <><Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} /><Page><Text style={styles.loading}>今日の家事を読み込んでいます。</Text></Page></>;
  }

  if (!snapshot.settings.setupCompleted) {
    return (
      <>
        <Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} />
        <FirstRunSetup snapshot={snapshot} onComplete={refresh} loadError={error} />
      </>
    );
  }

  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const completedToday = new Set(snapshot.completions
    .filter((item) => item.outcome === 'completed'
      && localDateFromISODateTime(item.completedAt) === today
      && (!item.scheduledDate || item.scheduledDate <= today))
    .map((item) => item.choreId));
  const dueToday = snapshot.scheduleEntries
    .filter((entry) => entry.status === 'overdue' || entry.suggestedDate === today)
    .sort((left, right) => urgency(left.status) - urgency(right.status));
  const pendingToday = dueToday.filter((entry) => !completedToday.has(entry.choreId));
  const completedTodayChores = [...completedToday]
    .map((choreId) => choresById.get(choreId))
    .filter((chore) => chore !== undefined);
  const todayTotal = pendingToday.length + completedTodayChores.length;
  const todayDone = completedTodayChores.length;
  const progress = todayTotal ? Math.round((todayDone / todayTotal) * 100) : 0;
  const todayWaste = snapshot.upcomingWasteDates.filter((occurrence) => occurrence.date === today);

  const finish = async (entryId: string) => {
    const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === entryId);
    if (!entry || completingIds.has(entryId)) return;
    setCompletingIds((current) => new Set(current).add(entryId));
    let inserted = false;
    try {
      inserted = await completeChore(database, entry);
      if (inserted) {
        setAnimatedCompletedChoreIds((current) => new Set(current).add(entry.choreId));
      }
      await refresh();
    } finally {
      setCompletingIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  };

  const hideWasteOccurrence = async (scheduleId: string, date: LocalDate) => {
    try {
      await setWasteOccurrenceHidden(database, scheduleId, date, true);
      setWasteMessage('この日のゴミ予定だけを非表示にしました。ゴミ曜日から再表示できます。');
      await refresh();
    } catch {
      setWasteMessage('ゴミ予定を非表示にできませんでした。');
    }
  };

  return (
    <>
      <Tabs.Screen options={{ tabBarStyle: { backgroundColor: '#FFFFFF', borderTopColor: palette.border, borderTopWidth: 1 } }} />
      <Page contentStyle={styles.homePage}>
        {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <View style={styles.todayHeading}>
        <View style={styles.todayCopy}>
          <Text style={styles.date}>{formatJapaneseDate(today, { year: true, weekday: true })}</Text>
          <Text style={styles.title}>今日のタスク</Text>
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="設定を開く" onPress={() => router.push('/settings')} style={styles.settingsButton}>
          <Text style={styles.settingsSymbol}>⚙︎</Text>
        </Pressable>
      </View>

      <Card style={styles.progressCard}>
        <View style={styles.progressHeader}>
          <View style={styles.progressCopy}>
            <Text style={styles.progressTitle}>今日も一日頑張りましょう</Text>
            <Text style={styles.progressCaption}>{todayTotal}件中{todayDone}件が完了しました</Text>
          </View>
          <Text style={styles.progressValue}>{progress}%</Text>
        </View>
        <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]} /></View>
      </Card>

      {snapshot.weatherOutcome === 'adjusted' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気に合わせて洗濯予定を調整しました</Text>
          <Text style={styles.noticeBody}>{snapshot.weatherAdjustmentCount}件の予定を見直しています。</Text>
        </Card>
      ) : snapshot.weatherOutcome === 'unavailable' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気予報を取得できませんでした</Text>
          <Text style={styles.noticeBody}>通常の家事予定を表示しています。</Text>
        </Card>
      ) : null}

      {todayWaste.length ? (
        <Card style={styles.wasteCard}>
          <View style={styles.wasteCopy}>
            <Text style={styles.wasteEyebrow}>今日のゴミ収集</Text>
            {todayWaste.map((item) => (
              <View key={`${item.scheduleId}-${item.date}`} style={styles.wasteRow}>
                <Text style={styles.wasteName}>{item.label}</Text>
                <Pressable accessibilityRole="button" onPress={() => void hideWasteOccurrence(item.scheduleId, item.date)}>
                  <Text style={styles.hideWaste}>今回だけ非表示</Text>
                </Pressable>
              </View>
            ))}
          </View>
          <Pressable accessibilityRole="button" onPress={() => router.push('/waste')} style={styles.wasteButton}>
            <Text style={styles.wasteButtonText}>曜日</Text>
          </Pressable>
        </Card>
      ) : null}
      {wasteMessage ? <Text style={styles.noticeBody}>{wasteMessage}</Text> : null}

      <SectionHeading title="今日の家事" trailing={<Text style={styles.smallCount}>{todayTotal}件・{todayDone}件完了</Text>} />
      {pendingToday.map((entry) => {
        const chore = choresById.get(entry.choreId);
        if (!chore) return null;
        return (
          <Animated.View key={entry.id} exiting={SlideOutRight.duration(280)} layout={LinearTransition.duration(240)}>
            <TaskCheckboxRow
              chore={chore}
              onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })}
              onToggle={completingIds.has(entry.id) ? undefined : () => void finish(entry.id)}
            />
          </Animated.View>
        );
      })}
      {completedTodayChores.map((chore) => (
        <Animated.View
          key={`completed-${chore.id}`}
          entering={animatedCompletedChoreIds.has(chore.id) ? SlideInLeft.duration(320) : undefined}
          layout={LinearTransition.duration(240)}>
          <TaskCheckboxRow chore={chore} completed onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })} />
        </Animated.View>
      ))}
      {todayTotal === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>今日の予定はありません</Text>
          <Text style={styles.emptyBody}>家事一覧から予定や頻度を調整できます。</Text>
          <Pressable accessibilityRole="button" onPress={() => router.push('/chores')}><Text style={styles.textLink}>家事一覧を見る ›</Text></Pressable>
        </Card>
      ) : null}

      <View style={styles.weekSwitcher}>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: weekScope === 'current' }} onPress={() => setWeekScope('current')} style={[styles.weekOption, weekScope === 'current' && styles.weekOptionSelected]}>
          <Text style={[styles.weekOptionText, weekScope === 'current' && styles.weekOptionTextSelected]}>今週</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityState={{ selected: weekScope === 'next' }} onPress={() => setWeekScope('next')} style={[styles.weekOption, weekScope === 'next' && styles.weekOptionSelected]}>
          <Text style={[styles.weekOptionText, weekScope === 'next' && styles.weekOptionTextSelected]}>来週</Text>
        </Pressable>
      </View>

      {upcomingByDate.length ? upcomingByDate.map(([date, entries]) => (
        <View key={date} style={styles.dayGroup}>
          <Text style={styles.dayGroupTitle}>{formatJapaneseDate(date, { weekday: true }).replace(/^\d+月/, '')}のタスク</Text>
          {entries.map((row) => {
            const chore = choresById.get(row.choreId);
            if (!chore) return null;
            return (
              <Animated.View key={row.id} entering={row.completed && animatedCompletedChoreIds.has(row.choreId) ? SlideInLeft.duration(320) : undefined} exiting={SlideOutRight.duration(280)} layout={LinearTransition.duration(240)}>
                <TaskCheckboxRow
                  chore={chore}
                  completed={row.completed}
                  onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id } })}
                  onToggle={!row.entry || row.completed || completingIds.has(row.entry.id) ? undefined : () => void finish(row.entry!.id)}
                />
              </Animated.View>
            );
          })}
        </View>
      )) : (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyBody}>{weekScope === 'current' ? '今週のこれからの予定はありません。' : '来週の予定はまだありません。'}</Text>
        </Card>
      )}

      <View style={styles.quickLinks}>
        <Pressable accessibilityRole="button" onPress={() => router.push('/history')}><Text style={styles.textLink}>実施履歴を見る ›</Text></Pressable>
        <Pressable accessibilityRole="button" onPress={() => router.push('/waste')}><Text style={styles.textLink}>ゴミ曜日を管理 ›</Text></Pressable>
      </View>
      </Page>
    </>
  );
}

function urgency(status: string): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}

const styles = StyleSheet.create({
  homePage: { gap: 12, paddingTop: 8, paddingBottom: 24 },
  todayHeading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 0 },
  todayCopy: { flex: 1, gap: 2 },
  settingsButton: { width: 48, height: 48, borderRadius: 15, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  settingsSymbol: { color: '#FFFFFF', fontSize: 24, lineHeight: 29 },
  date: { color: palette.muted, fontSize: 11, fontWeight: '500' },
  title: { color: palette.ink, fontSize: 28, fontWeight: '800' },
  progressCard: { backgroundColor: '#ECFAFD', borderColor: '#ECFAFD', padding: 17, gap: 10 },
  progressHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  progressCopy: { flex: 1, gap: 2 },
  progressTitle: { color: palette.accent, fontSize: 13, fontWeight: '800' },
  progressCaption: { color: palette.muted, fontSize: 11, fontWeight: '600' },
  progressValue: { color: palette.accent, fontSize: 28, fontWeight: '800' },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: palette.accent },
  weatherNotice: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, gap: 4 },
  noticeTitle: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  noticeBody: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  wasteCard: { flexDirection: 'row', alignItems: 'center', padding: 13, gap: 12, backgroundColor: '#F0FAFD', borderColor: '#D9F0F8' },
  wasteCopy: { flex: 1, gap: 4 },
  wasteEyebrow: { color: palette.accent, fontSize: 11, fontWeight: '800' },
  wasteRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 7 },
  wasteName: { color: palette.ink, fontSize: 13, fontWeight: '700', flex: 1 },
  hideWaste: { color: palette.accent, fontSize: 10, fontWeight: '700', textDecorationLine: 'underline' },
  wasteButton: { borderRadius: 11, backgroundColor: '#FFFFFF', paddingHorizontal: 12, paddingVertical: 9 },
  wasteButtonText: { color: palette.accent, fontSize: 12, fontWeight: '700' },
  smallCount: { color: palette.muted, fontSize: 11 },
  emptyCard: { paddingVertical: 18 },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  emptyBody: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  textLink: { color: palette.accent, fontSize: 12, fontWeight: '700', paddingVertical: 4 },
  weekSwitcher: { flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: palette.accentSoft, marginTop: 2 },
  weekOption: { flex: 1, minHeight: 34, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  weekOptionSelected: { backgroundColor: '#FFFFFF' },
  weekOptionText: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  weekOptionTextSelected: { color: palette.accent, fontWeight: '800' },
  dayGroup: { gap: 9, marginTop: 2 },
  dayGroupTitle: { color: palette.muted, fontSize: 11, fontWeight: '600' },
  quickLinks: { flexDirection: 'row', justifyContent: 'space-between', paddingTop: 4 },
  loading: { color: palette.muted, fontSize: 13, paddingTop: 8 },
  error: { color: palette.warning, fontSize: 13 },
});
