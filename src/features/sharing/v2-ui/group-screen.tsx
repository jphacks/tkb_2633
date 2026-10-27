import { useCallback, useEffect, useRef, useState } from 'react';
import type { ComponentProps } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, BackButton, Card, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from './round-card';
import { V2ConfigurationEditor } from './configuration-editor';
import { V2DateForm } from './date-form';
import { V2CompletionForm } from './completion-form';
import { V2DateRequests } from './date-requests';
import { V2AssignmentForm } from './assignment-form';
import { V2AssignmentRequests } from './assignment-requests';
import { V2Calendar } from './calendar';
import { v2CalendarMonth } from './calendar-projection';
import type { LocalDate } from '../../../domain/shared/types';
import { V2CompletionHistoryCard } from './completion-history-card';
import { V2FormScrollView } from './form-controls';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2GroupUiSession } from './screen-session';
import { millisecondsUntilNextSharedDay } from '../group-clock';
import { privateOverlayForViewer } from './private-overlay';
import { V2PrivateTaskCard, V2PrivateTaskNotice } from './private-task-card';

export interface V2GroupScreenProps {
  purpose: 'development' | 'workspace'; workspaceName?: string; workspaceError?: string; onManage?: () => void;
  subscribe?: (changed: () => void) => () => void;
  loadSession: () => Promise<V2GroupUiSession>; view: 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests' | 'calendar'; choreId?: string;
  occurrenceId?: string; subjectId?: string; anchorDate?: string; onRound?: (occurrenceId: string, subjectId: string, anchorDate?: string) => void; onDate?: (occurrenceId: string, subjectId: string) => void;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void; onRequests?: () => void;
  onAssignment?: (occurrenceId: string, subjectId: string) => void; onAssignmentRequests?: () => void;
  onCalendar?: () => void;
}

export function V2GroupScreen({ purpose, workspaceName, workspaceError, onManage, subscribe, loadSession, view, choreId, onBack, onConfiguration, onHistory, onRequests, occurrenceId, subjectId, onRound, onDate, onAssignment, onAssignmentRequests, onCalendar, anchorDate }: V2GroupScreenProps) {
  const [session, setSession] = useState<V2GroupUiSession | null>(null); const [screenModel, setModel] = useState<Awaited<ReturnType<V2GroupUiSession['readModel']>> | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [expiredOpen, setExpiredOpen] = useState(false);
  const alive = useRef(false); const generation = useRef(0); const running = useRef(false);
  const readOptions = useRef(anchorDate ? { focusDate: anchorDate } : view === 'calendar' ? { calendarMonth: 'current' } : undefined);
  const readBinding = useRef({ anchorDate, view });
  const [calendarMonth, setCalendarMonth] = useState<LocalDate | null>(null); const [calendarDay, setCalendarDay] = useState<LocalDate | null>(null);
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    try {
      const preview = await loadSession(); const value = await preview.readModel(readOptions.current);
      if (alive.current && generation.current === revision) { setSession(preview); setModel(value); setError(null); } return true;
    } catch (cause) { if (alive.current && generation.current === revision) setError(cause instanceof Error ? cause.message : '共有データを読み込めませんでした。'); return false; }
  }, [loadSession]);
  useFocusEffect(useCallback(() => {
    alive.current = true;
    if (readBinding.current.anchorDate !== anchorDate || readBinding.current.view !== view) {
      readOptions.current = anchorDate ? { focusDate: anchorDate } : view === 'calendar' ? { calendarMonth: 'current' } : undefined;
      readBinding.current = { anchorDate, view };
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe?.(() => { clearTimeout(timer); timer = setTimeout(() => { if (alive.current && !running.current) void refresh(); }, 80); });
    void refresh(); return () => { alive.current = false; generation.current++; clearTimeout(timer); unsubscribe?.(); };
  }, [refresh, anchorDate, subscribe, view]));
  useEffect(() => {
    if (!screenModel) return;
    const zones = [screenModel.plan.timeZone, ...(screenModel.privateOverlay?.status === 'ready' ? [screenModel.privateOverlay.timeZone] : [])];
    const delay = Math.min(...zones.map((zone) => millisecondsUntilNextSharedDay(new Date(), zone)));
    const timer = setTimeout(() => { if (alive.current && !running.current) void refresh(); }, delay);
    return () => clearTimeout(timer);
  }, [screenModel, refresh]);
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return; running.current = true; generation.current++; setBusy(true); setError(null);
    let failure: unknown;
    try { await work(); } catch (cause) { failure = cause; }
    try {
      const loaded = await refresh(); if (!alive.current) return;
      if (failure) setError(failure instanceof Error ? failure.message : '操作を完了できませんでした。');
      else if (!loaded) setError('表示を更新できませんでした。画面を開き直して現在の状態を確認してください。');
    } finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const notice = <View style={styles.notice}>
    {purpose === 'workspace' ? <Text style={styles.noticeTitle}>{workspaceName ?? '共有グループ'}</Text> : null}
    <Text style={styles.caption}>{purpose === 'development' ? '検査用の独立したデータです。既存データやログイン中のアカウントを使わず、クラウドへ送信しません。' : '端末に保存した変更は、接続後に共有します。申請・回答は受付と必要な承認の完了後に確定します。'}</Text>
    {purpose === 'workspace' && onManage ? <AppButton title="グループの管理・切り替え" variant="quiet" compact onPress={onManage} /> : null}
    {workspaceError ? <Text accessibilityRole="alert" style={styles.error}>{workspaceError}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
  if (!screenModel?.personal || !session) return <V2ScreenFrame purpose={purpose} style={styles.safe}>{notice}<ActivityIndicator color={palette.accent} />
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></V2ScreenFrame>;
  // Strip local composition before passing the common model to shared forms and actions.
  const { personal, privateOverlay: privateValue, ...model } = screenModel;
  const privateOverlay = privateOverlayForViewer(privateValue, model.viewerUserId);
  const controller = session.controller;
  if (view === 'calendar') {
    const month = calendarMonth ?? v2CalendarMonth(model.plan.range.asOfDate).month;
    const selectMonth = async (day: LocalDate, selectedDate?: LocalDate) => {
      if (!alive.current || running.current) return;
      try {
        const next = v2CalendarMonth(day); readOptions.current = { calendarMonth: next.month }; setCalendarMonth(next.month);
        setCalendarDay(selectedDate ?? (model.plan.range.asOfDate.slice(0, 7) === next.month.slice(0, 7) ? model.plan.range.asOfDate : next.month));
        await run(async () => {});
      } catch (cause) { setError(cause instanceof Error ? cause.message : '表示する月を確認してください。'); }
    };
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2Calendar model={model} personal={personal} privateOverlay={privateOverlay} privateSource={session.privateTasks} month={month}
      selectedDate={calendarDay ?? model.plan.range.asOfDate} busy={busy} actions={controller.actions} run={run}
      onMonth={selectMonth} onSelectDate={(day) => { if (day.slice(0, 7) === month.slice(0, 7)) setCalendarDay(day); else void selectMonth(day, day); }}
      onRound={(id, subject, anchor) => onRound?.(id, subject, anchor)}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="共有カレンダー" /></View>} /></V2ScreenFrame>;
  }
  if (view === 'assignmentRequests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2AssignmentRequests model={model} actions={controller.actions} busy={busy} run={run}
      onResolve={onAssignment ? (id) => { const round = model.plan.occurrences.find((entry) => entry.id === id); if (round?.subjects[0]) onAssignment(id, round.subjects[0].id); } : undefined}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="担当の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'requests') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2DateRequests model={model} actions={controller.actions} busy={busy} run={run}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="日時の変更申請" /></View>} />
  </V2ScreenFrame>;
  if (view === 'configuration') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <V2FormScrollView contentContainerStyle={styles.page}>{notice}
      {choreId && model.configurations.some((entry) => entry.choreId === choreId) ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === choreId)?.name ?? '共有家事'} />
        <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} onBack={onBack} /></>
        : <><BackButton onPress={onBack} /><Text style={styles.body}>設定する家事を選んでください。</Text></>}
    </V2FormScrollView>
  </V2ScreenFrame>;
  if (view === 'round' || view === 'date' || view === 'assignment') {
    const round = model.plan.occurrences.find((entry) => entry.id === occurrenceId); const subject = round?.subjects.find((entry) => entry.id === subjectId);
    return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}><V2FormScrollView contentContainerStyle={styles.page}>
      {notice}<BackButton onPress={onBack} disabled={busy} />
      {round && subject ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === round.choreId)?.name ?? '共有家事'} />
        {view === 'assignment' ? <V2AssignmentForm model={model} round={round} actions={controller.actions} busy={busy} run={run} />
          : view === 'date' ? <V2DateForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} /> : <><V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} showActions
          onDate={onDate ? () => onDate(round.id, subject.id) : undefined}
          onAssignment={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          onAssignmentRequest={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          recommendation={personal.recommendations.find((entry) => entry.subjectOccurrenceId === subject.id)} onOpen={() => onConfiguration(round.choreId)} />
        <V2CompletionForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} /></>}
        <AppButton title="共通の設定を開く" variant="quiet" disabled={busy} onPress={() => onConfiguration(round.choreId)} /></>
        : <Text style={styles.body}>対象の家事回を表示できません。前の画面で現在の家事回を選んでください。</Text>}
    </V2FormScrollView></V2ScreenFrame>;
  }
  const recommendations = new Map(personal.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]));
  const card = (round: V2PlannedOccurrence, subject: V2SubjectPlan) => <V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run}
    recommendation={recommendations.get(subject.id)}
    onOpen={() => onRound ? onRound(round.id, subject.id) : onConfiguration(round.choreId)} />;
  if (view === 'history') return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <FlatList data={[...model.plan.history].reverse()} keyExtractor={(record) => record.operationId} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="実施履歴" /></>}
      ListEmptyComponent={<Card><Text style={styles.body}>実施記録はありません。</Text></Card>}
      renderItem={({ item }) => <V2CompletionHistoryCard model={model} record={item} actions={controller.actions} busy={busy} run={run} />} />
  </V2ScreenFrame>;
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId)).map((subject) => ({ round, subject })));
  const today = entries.filter(({ round, subject }) => round.activeInPeriod && (recommendations.get(subject.id)?.date ?? subject.suggestedDate) === model.plan.range.asOfDate);
  const homeRows = [...today.map((entry) => ({ source: 'shared' as const, key: `shared:${entry.subject.id}`, ...entry })),
    ...(privateOverlay?.status === 'ready' ? privateOverlay.home : []).map((row) => ({ source: 'personal' as const, key: row.key, row }))];
  const expired = entries.filter(({ subject }) => subject.showExpiredOnHome);
  return <V2ScreenFrame purpose={purpose} style={styles.safe} edges={['top']}>
    <FlatList data={homeRows} keyExtractor={(entry) => entry.key} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title={session.privateTasks ? '今日の家事' : '今日の共有家事'} />
        <V2PrivateTaskNotice overlay={privateOverlay} sharedTimeZone={model.plan.timeZone} />
        {privateOverlay?.status === 'ready' && privateOverlay.today !== model.plan.range.asOfDate ? <Text style={styles.caption}>個人の今日：{privateOverlay.today} · 共有の今日：{model.plan.range.asOfDate}</Text> : null}
        <Text style={styles.caption}>{purpose === 'development' ? '検査用の未送信操作' : '送信待ち'}：{model.pendingChanges}件</Text>
        {purpose === 'workspace' ? <AppButton title="今すぐ同期" variant="quiet" disabled={busy} onPress={() => void run(() => session.controller.sync())} /> : null}</>}
      ListEmptyComponent={<Card><Text style={styles.body}>{privateOverlay?.status === 'unavailable' ? '今日の共有家事はありません。個人家事は未取得です。' : '今日の家事はありません。'}</Text></Card>}
      renderItem={({ item }) => item.source === 'personal' ? <V2PrivateTaskCard row={item.row} source={session.privateTasks} busy={busy} run={run} /> : card(item.round, item.subject)}
      ListFooterComponent={<View style={styles.footer}>
        {expired.length ? <AccordionSection title={`期限を過ぎた家事（${expired.length}件）`} expanded={expiredOpen} onToggle={() => setExpiredOpen((value) => !value)}>
          {expired.map(({ round, subject }) => <View key={subject.id}>{card(round, subject)}</View>)}
        </AccordionSection> : null}
        <AppButton title="実施履歴" variant="secondary" disabled={busy} onPress={onHistory} />
        {onCalendar ? <AppButton title="共有カレンダー" variant="secondary" disabled={busy} onPress={onCalendar} /> : null}
        {onRequests ? <AppButton title="日時の変更申請" variant="secondary" disabled={busy} onPress={onRequests} /> : null}
        {onAssignmentRequests ? <AppButton title="担当の変更申請" variant="secondary" disabled={busy} onPress={onAssignmentRequests} /> : null}
        <Card><SectionHeading title={purpose === 'development' ? '設定を検査' : '共有家事の設定'} />{model.configurations.map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card>
      </View>} />
  </V2ScreenFrame>;
}
/** A visible, fixed QA banner also lets native automation fail closed after scrolling long instructions. */
function V2ScreenFrame({ purpose, children, ...props }: ComponentProps<typeof SafeAreaView> & { purpose: V2GroupScreenProps['purpose'] }) {
  return <SafeAreaView {...props}>{purpose === 'development' ? <Text style={styles.qaScope}>開発用・端末内プレビュー</Text> : null}{children}</SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 16, paddingBottom: 40 },
  qaScope: { ...typography.caption, color: palette.warning, paddingHorizontal: 16, paddingVertical: 4 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
