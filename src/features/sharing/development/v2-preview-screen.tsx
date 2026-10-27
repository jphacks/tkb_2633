import { useCallback, useRef, useState } from 'react';
import { useFocusEffect } from 'expo-router';
import { ActivityIndicator, FlatList, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import moment from 'moment-timezone';
import { AppButton, BackButton, Card, palette, ScreenHeading, SectionHeading, typography } from '../../../components/planner-ui';
import { AccordionSection } from '../../../components/accordion-section';
import { V2RoundCard } from '../v2-ui/round-card';
import { V2ConfigurationEditor } from '../v2-ui/configuration-editor';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2DevelopmentPreview, V2DevelopmentPreviewModel } from './v2-preview-session';

interface PreviewProps {
  development: boolean; loadSession: () => Promise<V2DevelopmentPreview>; view: 'home' | 'configuration' | 'history'; choreId?: string;
  onBack: () => void; onConfiguration: (choreId: string) => void; onHistory: () => void;
}

/** This UI exercises real local persistence, not cloud synchronization or account authorization. */
export function V2DevelopmentPreviewScreen(props: PreviewProps) {
  if (!props.development) return <Text>この画面は開発ビルド専用です。</Text>;
  return <LivePreview {...props} />;
}

function LivePreview({ loadSession, view, choreId, onBack, onConfiguration, onHistory }: PreviewProps) {
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
  if (view === 'configuration') return <SafeAreaView style={styles.safe} edges={['top']}>
    <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>{notice}
      {choreId && model.configurations.some((entry) => entry.choreId === choreId) ? <><ScreenHeading title={model.plan.chores.find((entry) => entry.id === choreId)?.name ?? '共有家事'} />
        <V2ConfigurationEditor model={model} choreId={choreId} controller={controller} onSaved={async () => { if (!await refresh()) throw new Error('保存済みです。表示を更新するため画面を開き直してください。'); }} onBack={onBack} /></>
        : <><BackButton onPress={onBack} /><Text style={styles.body}>検査する家事を選んでください。</Text></>}
    </ScrollView>
  </SafeAreaView>;
  const recommendations = new Map(model.personal.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]));
  const card = (round: V2PlannedOccurrence, subject: V2SubjectPlan) => <V2RoundCard model={model} round={round} subject={subject} actions={controller.actions} busy={busy} run={run}
    recommendation={recommendations.get(subject.id)}
    onOpen={() => onConfiguration(round.choreId)} onDate={() => onConfiguration(round.choreId)} onAssignment={() => onConfiguration(round.choreId)} onPast={() => onConfiguration(round.choreId)} />;
  if (view === 'history') return <SafeAreaView style={styles.safe} edges={['top']}>
    <FlatList data={[...model.plan.history].reverse()} keyExtractor={(record) => record.operationId} contentContainerStyle={styles.page} initialNumToRender={8}
      ListHeaderComponent={<>{notice}<BackButton onPress={onBack} disabled={busy} /><ScreenHeading title="実施履歴" /></>}
      ListEmptyComponent={<Card><Text style={styles.body}>実施記録はありません。</Text></Card>}
      renderItem={({ item }) => <Card><SectionHeading title={model.plan.chores.find((chore) => chore.id === item.choreId)?.name ?? '家事'} />
        <Text style={styles.body}>{moment(item.performedAt).tz(model.plan.timeZone).format('YYYY年M月D日 HH:mm')} · {item.active ? '実施済み' : '取消済み'}</Text>
        <Text style={styles.caption}>登録：{moment(item.recordedAt).tz(model.plan.timeZone).format('YYYY年M月D日 HH:mm')}</Text>
        {item.active ? <AppButton title="この完了を取り消す" compact variant="secondary" disabled={busy} onPress={() => run(() => controller.actions.undo(item.operationId))} /> : null}
      </Card>} />
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
        <Card><SectionHeading title="設定を検査" />{model.configurations.filter((entry) => entry.configuration).map((entry) =>
          <AppButton key={entry.choreId} title={`「${model.plan.chores.find((chore) => chore.id === entry.choreId)?.name ?? '家事'}」の設定`} variant="quiet" disabled={busy} onPress={() => onConfiguration(entry.choreId)} />)}</Card>
      </View>} />
  </SafeAreaView>;
}
const styles = StyleSheet.create({ safe: { flex: 1, backgroundColor: palette.background }, page: { padding: 16, gap: 16, paddingBottom: 40 },
  notice: { padding: 12, gap: 4, borderWidth: 1, borderRadius: 12, borderColor: palette.border }, noticeTitle: { ...typography.label, fontWeight: '600', color: palette.ink },
  caption: { ...typography.caption, color: palette.muted }, body: { ...typography.body, color: palette.ink }, error: { ...typography.caption, color: palette.warning }, footer: { gap: 16, paddingTop: 12 },
});
