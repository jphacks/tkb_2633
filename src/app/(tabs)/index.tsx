import { Tabs, router } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';

import { Card, Page, SectionHeading, palette } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { PlannerLoadState } from '@/components/planner-load-state';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import { orderDateTasks, selectDateTasks, type DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, formatJapaneseDate, localDateFromDate, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore, setWasteOccurrenceHidden, undoCompletedChore } from '@/platform/storage/repository';

type WeekScope = 'current' | 'next';

export default function HomeScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const [wasteMessage, setWasteMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [weekScope, setWeekScope] = useState<WeekScope>('current');
  const today = localDateFromDate(new Date());
  const thisWeekEnd = addDays(today, 7 - weekdayOf(today));
  const nextWeekStart = addDays(thisWeekEnd, 1);
  const nextWeekEnd = addDays(nextWeekStart, 6);
  const periodStart = weekScope === 'current' ? today : nextWeekStart;
  const periodEnd = weekScope === 'current' ? thisWeekEnd : nextWeekEnd;
  const upcomingByDate = useMemo(() => {
    const groups: [LocalDate, DateTask[]][] = [];
    if (!snapshot) return groups;
    const firstVisibleDate = periodStart > today ? periodStart : addDays(today, 1);
    for (let date = firstVisibleDate; date <= periodEnd; date = addDays(date, 1)) {
      const tasks = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, date), date, snapshot.chores);
      if (tasks.length) groups.push([date, tasks]);
    }
    return groups;
  }, [periodEnd, periodStart, snapshot, today]);

  if (loading || !snapshot) {
    return <><Tabs.Screen options={{ tabBarStyle: { display: 'none' } }} /><PlannerLoadState title="今日の家事" message="今日の家事を読み込んでいます。" error={error} retry={refresh} /></>;
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
  const orderedDueToday = orderDateTasks(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3), today, snapshot.chores);
  const todayTotal = orderedDueToday.length;
  const todayDone = orderedDueToday.filter((task) => task.completed).length;
  const progress = todayTotal ? Math.round((todayDone / todayTotal) * 100) : 0;
  const todayWaste = snapshot.upcomingWasteDates.filter((occurrence) => occurrence.date === today);

  const finish = async (entryId: string) => {
    const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === entryId);
    if (!entry || completingIds.has(entryId)) return;
    setCompletingIds((current) => new Set(current).add(entryId));
    setActionError(null);
    try {
      await completeChore(database, entry);
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

  const undo = async (completionId: string) => {
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
        {error || actionError ? <Card><Text style={styles.error}>{actionError ?? error}</Text></Card> : null}

      <View style={styles.todayHeading}>
        <View style={styles.todayCopy}>
          <Text style={styles.date}>{formatJapaneseDate(today, { year: true, weekday: true })}</Text>
          <Text style={styles.title}>今日のタスク</Text>
        </View>
        <View style={styles.headerActions}>
          <Pressable accessibilityRole="button" accessibilityLabel="ヘルプを開く" onPress={() => router.push('/help')} style={({ pressed }) => [styles.headerActionButton, pressed && styles.actionPressed]}>
            <Text style={styles.helpSymbol}>?</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="設定を開く" onPress={() => router.push('/settings')} style={({ pressed }) => [styles.headerActionButton, pressed && styles.actionPressed]}>
            <Text style={styles.settingsSymbol}>⚙︎</Text>
          </Pressable>
        </View>
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
      {orderedDueToday.map((task) => {
        const chore = choresById.get(task.choreId);
        if (!chore) return null;
        const { completed, entry, completion } = task;
        return (
          <Animated.View
            key={chore.id}
            layout={LinearTransition.duration(240)}>
            <TaskCheckboxRow
              chore={chore}
              completed={completed}
              deemphasized={today !== task.suggestedDate}
              onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home' } })}
              onToggle={completed
                ? completion && !completingIds.has(completion.id) ? () => void undo(completion.id) : undefined
                : entry && !completingIds.has(entry.id) ? () => void finish(entry.id) : undefined}
            />
          </Animated.View>
        );
      })}
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
            const completionId = row.completion?.id;
            const entryId = row.entry?.id;
            return (
              <Animated.View key={`${row.choreId}:${date}`} layout={LinearTransition.duration(240)}>
                <TaskCheckboxRow
                  chore={chore}
                  completed={row.completed}
                  deemphasized={row.suggestedDate !== date}
                  onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home' } })}
                  onToggle={row.completed
                    ? completionId && !completingIds.has(completionId) ? () => void undo(completionId) : undefined
                    : entryId && !completingIds.has(entryId) ? () => void finish(entryId) : undefined}
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

const styles = StyleSheet.create({
  homePage: { gap: 12, paddingTop: 8, paddingBottom: 24 },
  todayHeading: { minHeight: 48, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginTop: 0 },
  todayCopy: { flex: 1, gap: 2 },
  headerActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  headerActionButton: { width: 48, height: 48, borderRadius: 15, backgroundColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  helpSymbol: { color: '#FFFFFF', fontSize: 24, fontWeight: '800', lineHeight: 29 },
  settingsSymbol: { color: '#FFFFFF', fontSize: 30, lineHeight: 35, textAlign: 'center' },
  actionPressed: { opacity: 0.72 },
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
