import type { ReactElement } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { AppButton, Card, palette, SectionHeading, typography } from '../../../components/planner-ui';
import { CalendarTaskCountIndicator } from '../../../components/calendar-task-count-indicator';
import { DEFAULT_CALENDAR_COUNT_COLORS } from '../../../domain/calendar/count-colors';
import { formatJapaneseDate, weekdayOf } from '../../../domain/scheduling/local-date';
import type { CalendarCountColors, CalendarCountDisplayMode, LocalDate } from '../../../domain/shared/types';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { v2CalendarMonth, v2CalendarProjection } from './calendar-projection';
import { V2RoundCard } from './round-card';
import { privateOverlayForViewer } from './private-overlay';
import type { V2PrivateOverlayState, V2PrivateTaskSource } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';

export function V2Calendar({ model, personal, privateOverlay: privateValue, privateSource, month, selectedDate, busy, actions, run, onMonth, onSelectDate, onRound, header,
  countColors = DEFAULT_CALENDAR_COUNT_COLORS, countMode = 'bar' }: {
  model: V2GroupScreenModel; personal?: V2PersonalPlan; month: LocalDate; selectedDate: LocalDate; busy: boolean;
  actions: V2GroupController['actions']; run: (work: () => Promise<unknown>) => Promise<void>;
  onMonth: (month: LocalDate) => void; onSelectDate: (date: LocalDate) => void;
  onRound: (occurrenceId: string, subjectId: string, anchorDate: LocalDate) => void; header?: ReactElement;
  countColors?: CalendarCountColors; countMode?: CalendarCountDisplayMode;
  privateOverlay?: V2PrivateOverlayState; privateSource?: V2PrivateTaskSource;
}) {
  const grid = v2CalendarMonth(month); const projection = v2CalendarProjection(model, personal);
  const privateOverlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const loaded = model.plan.initialized && model.plan.range.from <= grid.from && model.plan.range.through >= grid.through;
  const privateLoaded = privateOverlay?.status === 'ready' && privateOverlay.range.from <= grid.from && privateOverlay.range.through >= grid.through;
  const sharedEntries = loaded ? projection.byDate.get(selectedDate) ?? [] : [];
  const entries = [...sharedEntries.map((entry) => ({ source: 'shared' as const, key: `shared:${entry.id}`, entry })),
    ...(privateLoaded ? privateOverlay.byDate.get(selectedDate) ?? [] : []).map((row) => ({ source: 'personal' as const, key: row.key, row }))];
  const move = (offset: number) => { let next; try { next = v2CalendarMonth(grid.month, offset).month; } catch { return; } onMonth(next); };
  const canMove = (offset: number) => { try { v2CalendarMonth(grid.month, offset); return true; } catch { return false; } };
  return <FlatList data={entries} keyExtractor={(entry) => entry.key} initialNumToRender={8} contentContainerStyle={styles.page}
    ListHeaderComponent={<View style={{ gap: 14 }}>{header}<Card>
      <View style={styles.monthHeader}><AppButton title="‹" accessibilityLabel="前の月" compact variant="secondary" disabled={busy || !canMove(-1)} onPress={() => move(-1)} />
        <Text style={styles.monthTitle}>{grid.year}年{grid.monthNumber}月</Text>
        <AppButton title="›" accessibilityLabel="次の月" compact variant="secondary" disabled={busy || !canMove(1)} onPress={() => move(1)} /></View>
      <View style={styles.week}>{['日', '月', '火', '水', '木', '金', '土'].map((day, index) => <Text key={day} style={[styles.weekday, (index === 0 || index === 6) && styles.weekend]}>{day}</Text>)}</View>
      <View>{Array.from({ length: grid.cells.length / 7 }, (_, week) => <View style={styles.week} key={grid.cells[week * 7]}>
        {grid.cells.slice(week * 7, week * 7 + 7).map((day) => {
          const selected = day === selectedDate; const today = day === model.plan.range.asOfDate;
          const sharedCount = loaded ? projection.counts.get(day) ?? 0 : 0; const privateCount = privateLoaded ? privateOverlay.counts.get(day) ?? 0 : 0;
          const count = sharedCount + privateCount;
          const countLabel = `${formatJapaneseDate(day, { year: true })}、${loaded ? `確認できる未完了の共有家事${sharedCount}件` : '予定は未取得'}${privateValue ? privateLoaded ? `、個人家事${privateCount}件` : '、個人家事は未取得' : ''}`;
          return <View key={day} style={styles.daySlot}><Pressable accessibilityRole="button" accessibilityLabel={countLabel}
            accessibilityState={{ selected, disabled: busy || !loaded }} disabled={busy || !loaded} onPress={() => onSelectDate(day)}
            style={[styles.day, today && styles.today, selected && styles.selected]}>
            <Text style={[styles.number, day.slice(0, 7) !== grid.month.slice(0, 7) && styles.outside,
              (weekdayOf(day) === 6 || weekdayOf(day) === 7) && styles.weekend, selected && styles.selectedNumber]}>{Number(day.slice(-2))}</Text>
            <CalendarTaskCountIndicator count={count} colors={countColors} mode={countMode} selected={selected} />
          </Pressable></View>;
        })}
      </View>)}</View>
    </Card><SectionHeading title={formatJapaneseDate(selectedDate, { year: true, weekday: true })} />
      <Text style={styles.caption}>{privateValue ? '点と棒：共有と個人の推奨日の未完了数' : '点と棒：確認できる未完了数'}</Text>
      <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} date={selectedDate} />
      {privateOverlay?.status === 'ready' && !privateLoaded ? <Text style={styles.caption}>この月の個人家事は未取得です。月を再読込してください。</Text> : null}
      {busy ? <Text style={styles.caption}>共有予定を読み込んでいます…</Text> : !loaded ? <><Text style={styles.caption}>この月の共有予定を取得できていません。</Text>
        <AppButton title="この月を再読込" variant="secondary" onPress={() => onMonth(grid.month)} /></> : null}
    </View>}
    ListEmptyComponent={loaded && !busy ? <Card><Text style={styles.caption}>{privateValue ? 'この日の共有家事はありません。取得済みの個人家事は上の案内に沿って表示します。' : 'この日の共有家事はありません。'}</Text></Card> : undefined}
    renderItem={({ item }) => item.source === 'personal' ? <V2PrivateTaskCard row={item.row} source={privateSource} busy={busy} run={run} />
      : <V2RoundCard model={model} round={item.entry.round} subject={item.entry.subject} recommendation={item.entry.recommendation}
        actions={actions} busy={busy} run={run} onOpen={() => onRound(item.entry.round.id, item.entry.subject.id, item.entry.round.anchorDate)} />} />;
}
const styles = StyleSheet.create({
  page: { padding: 16, paddingBottom: 40, gap: 14 }, monthHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
  monthTitle: { ...typography.section, color: palette.ink, fontWeight: '700' }, week: { flexDirection: 'row', alignItems: 'stretch' },
  weekday: { flex: 1, ...typography.calendarLabel, color: palette.muted, textAlign: 'center', paddingVertical: 5 },
  daySlot: { width: `${100 / 7}%`, padding: 2 }, day: { minHeight: 46, justifyContent: 'center', gap: 2, borderRadius: 10, alignItems: 'center' },
  number: { ...typography.calendarDate, color: palette.ink, fontWeight: '600' }, outside: { opacity: 0.45 }, weekend: { color: palette.muted },
  today: { backgroundColor: palette.accentSoft }, selected: { backgroundColor: palette.accent }, selectedNumber: { color: '#FFFFFF' },
  caption: { ...typography.caption, color: palette.muted },
});
