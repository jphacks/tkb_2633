import { Tabs, router } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { ActionLabel, AppButton, Card, Page, SectionHeading, palette, typography } from '@/components/planner-ui';
import { plannerTabBarLayout } from '@/components/planner-tab-bar';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { WasteOccurrenceCard } from '@/components/waste-occurrence-card';
import { PlannerLoadState } from '@/components/planner-load-state';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import { orderDateTasks, selectDateTasks, type DateTask } from '@/domain/scheduling/date-tasks';
import { addDays, formatJapaneseDate, localDateFromDate, weekdayOf } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { useWasteOccurrenceToggle } from '@/features/waste/use-waste-occurrence-toggle';
import { WeatherAttribution } from '@/components/data-credits';
import { useTaskCompletion } from '@/hooks/use-task-completion';
import { useHomeClock } from '@/hooks/use-home-clock';
import { homeSummary } from '@/features/planner/home-summary';
import { isTaskUrgent } from '@/domain/scheduling/task-priority';

type WeekScope = 'current' | 'next';

export default function HomeScreen() {
  const insets = useSafeAreaInsets();
  const { snapshot, loading, error, refresh, database, readError } = usePlannerData();
  const completion = useTaskCompletion(database, refresh, readError);
  const clock = useHomeClock(snapshot?.timeZone);
  const wasteVisibility = useWasteOccurrenceToggle(database, refresh);
  const actionError = completion.error;
  const [weekScope, setWeekScope] = useState<WeekScope>('current');
  const today = snapshot?.today ?? localDateFromDate(new Date());
  const thisWeekEnd = addDays(today, 7 - weekdayOf(today));
  const nextWeekStart = addDays(thisWeekEnd, 1);
  const nextWeekEnd = addDays(nextWeekStart, 6);
  const periodStart = weekScope === 'current' ? today : nextWeekStart;
  const periodEnd = weekScope === 'current' ? thisWeekEnd : nextWeekEnd;
  const upcomingByDate = (() => {
    const groups: [LocalDate, DateTask[]][] = [];
    if (!snapshot) return groups;
    const firstVisibleDate = periodStart > today ? periodStart : addDays(today, 1);
    for (let date = firstVisibleDate; date <= periodEnd; date = addDays(date, 1)) {
      const tasks = orderDateTasks(completion.project(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, date, 0, snapshot.chores), snapshot.completions), date, snapshot.chores, today);
      if (tasks.length) groups.push([date, tasks]);
    }
    return groups;
  })();

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
  const orderedDueToday = orderDateTasks(completion.project(selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3, snapshot.chores), snapshot.completions), today, snapshot.chores);
  const todayTotal = orderedDueToday.length;
  const todayDone = orderedDueToday.filter((task) => task.completed).length;
  const summary = homeSummary(todayTotal, todayDone, clock, snapshot.timeZone);
  const progress = summary.percent;
  const todayWaste = snapshot.upcomingWasteDates.filter((occurrence) => occurrence.date === today);

  return (
    <>
      <Tabs.Screen options={{ tabBarStyle: { ...plannerTabBarLayout(insets.bottom), backgroundColor: '#FFFFFF', borderTopColor: palette.border, borderTopWidth: 1 } }} />
      <Page contentStyle={styles.homePage}>
        {error || actionError ? <Card><Text style={styles.error}>{actionError ?? error}</Text><AppButton title="表示を再読込" variant="quiet" compact
          disabled={completion.pending.size > 0 || completion.reading} onPress={() => void completion.retryRead()} /></Card> : null}

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
            <Text style={styles.progressTitle}>{summary.greeting}</Text>
            {summary.showProgress ? <Text style={styles.progressCaption}>{todayTotal}件中{todayDone}件が完了しました</Text> : null}
          </View>
          {summary.showProgress ? <Text style={styles.progressValue}>{progress}%</Text> : null}
        </View>
        {summary.showProgress ? <View style={styles.progressTrack}><View style={[styles.progressFill, { width: `${progress}%` }]} /></View> : null}
      </Card>

      {snapshot.weatherOutcome === 'adjusted' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気に合わせて洗濯予定を調整しました</Text>
          <Text style={styles.noticeBody}>{snapshot.weatherAdjustmentCount}件の予定を見直しています。</Text>
          <WeatherAttribution />
        </Card>
      ) : snapshot.weatherOutcome === 'unavailable' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.noticeTitle}>天気予報を取得できませんでした</Text>
          <Text style={styles.noticeBody}>通常の家事予定を表示しています。</Text>
        </Card>
      ) : null}

      {todayWaste.map((item) => (
        <WasteOccurrenceCard key={`${item.scheduleId}:${item.date}`} occurrence={item}
          busy={wasteVisibility.busyKeys.has(`${item.scheduleId}:${item.date}`)}
          onToggle={() => void wasteVisibility.toggle(item, false)} />
      ))}
      {wasteVisibility.error ? <Text style={styles.error}>{wasteVisibility.error}</Text> : null}

      <SectionHeading title="今日の家事" trailing={<Text style={styles.smallCount}>{todayTotal}件・{todayDone}件完了</Text>} />
      {orderedDueToday.map((task) => {
        const chore = choresById.get(task.choreId);
        if (!chore) return null;
        const { completed } = task;
        return (
          <Animated.View
            key={chore.id}
            layout={LinearTransition.duration(240)}>
            <TaskCheckboxRow
              chore={chore}
              completed={completed}
              source={snapshot.sharing ? 'shared' : 'personal'}
              early={today < task.suggestedDate}
              urgent={isTaskUrgent({ completed, load: chore.load, recommendedDate: task.suggestedDate, windowEnd: task.entry?.windowEnd ?? task.completion?.scheduledWindowEnd }, today)}
              onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home' } })}
              onToggle={completion.canToggle(task) ? () => void completion.toggle(task) : undefined}
            />
          </Animated.View>
        );
      })}
      {todayTotal === 0 ? (
        <Card style={styles.emptyCard}>
          <Text style={styles.emptyTitle}>今日の予定はありません</Text>
          <Text style={styles.emptyBody}>家事一覧から予定や頻度を調整できます。</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="家事一覧を見る" onPress={() => router.push('/chores')}><ActionLabel label="家事一覧を見る" style={styles.textLink} /></Pressable>
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
              <Animated.View key={`${row.choreId}:${date}`} layout={LinearTransition.duration(240)}>
                <TaskCheckboxRow
                  chore={chore}
                  completed={row.completed}
                  source={snapshot.sharing ? 'shared' : 'personal'} early={date < row.suggestedDate}
                  onOpen={() => router.navigate({ pathname: '/(tabs)/guide', params: { choreId: chore.id, returnTo: 'home' } })}
                  onToggle={completion.canToggle(row) ? () => void completion.toggle(row) : undefined}
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
        <Pressable accessibilityRole="button" accessibilityLabel="実施履歴を見る" onPress={() => router.push('/history')}><ActionLabel label="実施履歴を見る" style={styles.textLink} /></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="ゴミ曜日を管理" onPress={() => router.push('/waste')}><ActionLabel label="ゴミ曜日を管理" style={styles.textLink} /></Pressable>
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
  settingsSymbol: { color: '#FFFFFF', fontSize: 30, lineHeight: 35, textAlign: 'center', top: -2 },
  actionPressed: { opacity: 0.72 },
  date: { ...typography.caption, color: palette.muted, fontWeight: '500' },
  title: { ...typography.title, color: palette.ink, fontWeight: '800' },
  progressCard: { backgroundColor: '#ECFAFD', borderColor: '#ECFAFD', padding: 17, gap: 10 },
  progressHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
  progressCopy: { flex: 1, gap: 2 },
  progressTitle: { ...typography.label, color: palette.accent, fontWeight: '800' },
  progressCaption: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  progressValue: { ...typography.title, color: palette.accent, fontWeight: '800' },
  progressTrack: { height: 5, borderRadius: 3, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 3, backgroundColor: palette.accent },
  weatherNotice: { backgroundColor: palette.accentSoft, borderColor: palette.accentSoft, gap: 4 },
  noticeTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  noticeBody: { ...typography.body, color: palette.muted },
  smallCount: { ...typography.caption, color: palette.muted },
  emptyCard: { paddingVertical: 18 },
  emptyTitle: { ...typography.body, color: palette.ink, fontWeight: '700' },
  emptyBody: { ...typography.body, color: palette.muted },
  textLink: { ...typography.label, color: palette.accent, fontWeight: '700', paddingVertical: 10 },
  weekSwitcher: { flexDirection: 'row', padding: 4, borderRadius: 14, backgroundColor: palette.accentSoft, marginTop: 2 },
  weekOption: { flex: 1, minHeight: 44, borderRadius: 11, alignItems: 'center', justifyContent: 'center' },
  weekOptionSelected: { backgroundColor: '#FFFFFF' },
  weekOptionText: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  weekOptionTextSelected: { color: palette.accent, fontWeight: '800' },
  dayGroup: { gap: 9, marginTop: 2 },
  dayGroupTitle: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  quickLinks: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'space-between', columnGap: 16, paddingTop: 4 },
  loading: { ...typography.label, color: palette.muted, paddingTop: 8 },
  error: { ...typography.label, color: palette.warning },
});
