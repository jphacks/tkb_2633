import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, BackButton, Card, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from '../v2-ui/round-card';
import { V2ConfigurationEditor } from '../v2-ui/configuration-editor';
import { V2DateForm } from '../v2-ui/date-form';
import { V2CompletionForm } from '../v2-ui/completion-form';
import { V2DateRequests } from '../v2-ui/date-requests';
import { V2AssignmentForm } from '../v2-ui/assignment-form';
import { V2AssignmentRequests } from '../v2-ui/assignment-requests';
import { V2CompletionHistoryCard } from '../v2-ui/completion-history-card';
import { V2FormScrollView } from '../v2-ui/form-controls';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2DevelopmentPreview, V2DevelopmentPreviewModel } from './v2-preview-session';

interface PreviewProps {
  development: boolean; loadSession: () => Promise<V2DevelopmentPreview>; view: 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests'; choreId?: string;
  occurrenceId?: string; subjectId?: string; onRound?: (occurrenceId: string, subjectId: string) => void; onDate?: (occurrenceId: string, subjectId: string) => void;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void; onRequests?: () => void;
  onAssignment?: (occurrenceId: string, subjectId: string) => void; onAssignmentRequests?: () => void;
}

/** This UI exercises real local persistence, not cloud synchronization or account authorization. */
export function V2DevelopmentPreviewScreen(props: PreviewProps) {
  if (!props.development) return <Text>この画面は開発ビルド専用です。</Text>;
  return <LivePreview {...props} />;
}

function LivePreview({ loadSession, view, choreId, onBack, onConfiguration, onHistory, onRequests, occurrenceId, subjectId, onRound, onDate, onAssignment, onAssignmentRequests }: PreviewProps) {
  const [session, setSession] = useState<V2DevelopmentPreview | null>(null); const [model, setModel] = useState<V2DevelopmentPreviewModel | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null); const [expiredOpen, setExpiredOpen] = useState(false);
  const alive = useRef(false); const generation = useRef(0); const running = useRef(false);
  const refresh = useCallback(async () => {
    const revision = ++generation.current;
    try {
      const preview = await loadSession(); const value = await preview.readModel();
      if (alive.current && generation.current === revision) { setSession(preview); setModel(value); setError(null); } return true;
    } catch (cause) { if (alive.current && generation.current === revision) setError(cause instanceof Error ? cause.message : '検査用の画面を読み込めませんでした。'); return false; }
  }, [loadSession]);
  useFocusEffect(useCallback(() => { alive.current = true; void refresh(); return () => { alive.current = false; generation.current++; }; }, [refresh]));
  const run = async (work: () => Promise<unknown>) => {
    if (running.current) return; running.current = true; generation.current++; setBusy(true); setError(null);
    let failure: unknown;
    try { await work(); } catch (cause) { failure = cause; }
    try {
      const loaded = await refresh(); if (!alive.current) return;
      if (failure) setError(failure instanceof Error ? failure.message : '操作を完了できませんでした。');
      else if (!loaded) setError('端末に保存済みです。表示を更新できなかったため、画面を開き直してください。');
    } finally { running.current = false; if (alive.current) setBusy(false); }
  };
  const notice = <View style={styles.notice}>
    <Text style={styles.noticeTitle}>開発用・端末内プレビュー</Text>
    <Text style={styles.caption}>検査用の独立したデータです。既存データやログイン中のアカウントを使わず、クラウドへ送信しません。</Text>
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
  </View>;
  if (!model?.personal || !session) return <SafeAreaView style={styles.safe}>{notice}<ActivityIndicator color={palette.accent} />
    <AppButton title="読み込みを再試行" variant="quiet" onPress={() => void refresh()} /></SafeAreaView>;
  const controller = session.controller;
  if (view === 'assignmentRequests') return <SafeAreaView style={styles.safe} edges={['top']}>
    <V2AssignmentRequests model={model} actions={controller.actions} busy={busy} run={run}
      onResolve={onAssignment ? (id) => { const round = model.plan.occurrences.find((entry) => entry.id === id); if (round?.subjects[0]) onAssignment(id, round.subjects[0].id); } : undefined}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="担当の変更申請" /></View>} />
  </SafeAreaView>;
  if (view === 'requests') return <SafeAreaView style={styles.safe} edges={['top']}>
    <V2DateRequests model={model} actions={controller.actions} busy={busy} run={run}
      header={<View style={{ gap: 16 }}>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="日時の変更申請" /></View>} />
  </SafeAreaView>;
  if (view === 'configuration') return <SafeAreaView style={styles.safe} edges={['top']}>
    <V2FormScrollView contentContainerStyle={styles.page}>{notice}
      {choreId && model.configurations.some((entry) => entry.choreId === choreId) ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === choreId)?.name ?? '共有家事'} />
        <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} onBack={onBack} /></>
        : <><BackButton onPress={onBack} /><Text style={styles.body}>検査する家事を選んでください。</Text></>}
    </V2FormScrollView>
  </SafeAreaView>;
  if (view === 'round' || view === 'date' || view === 'assignment') {
    const round = model.plan.occurrences.find((entry) => entry.id === occurrenceId); const subject = round?.subjects.find((entry) => entry.id === subjectId);
    return <SafeAreaView style={styles.safe} edges={['top']}><V2FormScrollView contentContainerStyle={styles.page}>
      {notice}<BackButton onPress={onBack} disabled={busy} />
      {round && subject ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === round.choreId)?.name ?? '共有家事'} />
        {view === 'assignment' ? <V2AssignmentForm model={model} round={round} actions={controller.actions} busy={busy} run={run} />
          : view === 'date' ? <V2DateForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} /> : <><V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} showActions
          onDate={onDate ? () => onDate(round.id, subject.id) : undefined}
          onAssignment={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          onAssignmentRequest={onAssignment ? () => onAssignment(round.id, subject.id) : undefined}
          recommendation={model.personal.recommendations.find((entry) => entry.subjectOccurrenceId === subject.id)} onOpen={() => onConfiguration(round.choreId)} />
        <V2CompletionForm model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run} /></>}
        <AppButton title="共通の設定を開く" variant="quiet" disabled={busy} onPress={() => onConfiguration(round.choreId)} /></>
        : <Text style={styles.body}>対象の家事回を表示できません。前の画面で現在の家事回を選んでください。</Text>}
    </V2FormScrollView></SafeAreaView>;
  }
  const recommendations = new Map(model.personal.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]));
  const card = (round: V2PlannedOccurrence, subject: V2SubjectPlan) => <V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run}
    recommendation={recommendations.get(subject.id)}
    onOpen={() => onRound ? onRound(round.id, subject.id) : onConfiguration(round.choreId)} />;
  if (view === 'history') return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={[...model.plan.history].reverse()} keyExtractor={(record) => record.operationId} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="実施履歴" /></>}
      ListEmptyComponent={<Card><Text style={styles.body}>実施記録はありません。</Text></Card>}
      renderItem={({ item }) => <V2CompletionHistoryCard model={model} record={item} actions={controller.actions} busy={busy} run={run} />} />
  </SafeAreaView>;
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required && (subject.subjectUserId === null || subject.subjectUserId === model.viewerUserId)).map((subject) => ({ round, subject })));
  const today = entries.filter(({ round, subject }) => round.activeInPeriod && (recommendations.get(subject.id)?.date ?? subject.suggestedDate) === model.plan.range.asOfDate);
  const expired = entries.filter(({ subject }) => subject.showExpiredOnHome);
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={today} keyExtractor={({ subject }) => subject.id} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="今日の共有家事" />
        <Text style={styles.caption}>検査用の未送信操作：{model.pendingChanges}件</Text></>}
      ListEmptyComponent={<Card><Text style={styles.body}>今日の家事はありません。</Text></Card>}
      renderItem={({ item }) => card(item.round, item.subject)}
      ListFooterComponent={<View style={styles.footer}>
        {expired.length ? <AccordionSection title={`期限を過ぎた家事（${expired.length}件）`} expanded={expiredOpen} onToggle={() => setExpiredOpen((value) => !value)}>
          {expired.map(({ round, subject }) => <View key={subject.id}>{card(round, subject)}</View>)}
        </AccordionSection> : null}
        <AppButton title="実施履歴" variant="secondary" disabled={busy} onPress={onHistory} />
        {onRequests ? <AppButton title="日時の変更申請" variant="secondary" disabled={busy} onPress={onRequests} /> : null}
        {onAssignmentRequests ? <AppButton title="担当の変更申請" variant="secondary" disabled={busy} onPress={onAssignmentRequests} /> : null}
        <Card><SectionHeading title="設定を検査" />{model.configurations.filter((entry) => entry.configuration).map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card>
      </View>} />
  </SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 16, paddingBottom: 40 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
