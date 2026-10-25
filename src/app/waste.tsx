import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';
import { WasteScheduleEditor } from '@/features/waste/waste-schedule-editor';
import { wasteScheduleDescription } from '@/features/waste/schedule-policy';
import type { WasteScheduleInput } from '@/features/waste/contracts';
import { formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { deleteWeeklyWasteSchedule, saveWeeklyWasteSchedule, setWasteOccurrenceHidden } from '@/platform/storage/repository';

export default function WasteScreen() {
  const { snapshot, loading, error: loadError, refresh, database } = usePlannerData();
  const [editing, setEditing] = useState<WasteScheduleInput | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedUpcoming, setExpandedUpcoming] = useState(false);
  const [updatingOccurrence, setUpdatingOccurrence] = useState(false);

  if (loading || !snapshot) return <PlannerLoadState title="ゴミ収集日" message="曜日設定を読み込んでいます。" error={loadError} retry={refresh} />;

  const save = async (schedule: WasteScheduleInput) => {
    setSaving(true);
    setMessage(null);
    try {
      await saveWeeklyWasteSchedule(database, schedule);
      setEditing(undefined);
      await refresh();
      setMessage('収集日を保存しました。');
    } finally { setSaving(false); }
  };

  const remove = async (scheduleId: string) => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await deleteWeeklyWasteSchedule(database, scheduleId);
      if (editing?.id === scheduleId) setEditing(undefined);
      await refresh();
      setMessage('収集日を削除しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '収集日を削除できませんでした。');
    } finally {
      setSaving(false);
    }
  };

  const setOccurrenceHidden = async (scheduleId: string, date: `${number}-${number}-${number}`, hidden: boolean) => {
    if (updatingOccurrence) return;
    setUpdatingOccurrence(true);
    setMessage(null);
    try {
      await setWasteOccurrenceHidden(database, scheduleId, date, hidden);
      await refresh();
      setMessage(hidden ? 'この日の表示だけを非表示にしました。' : 'ゴミ予定を再表示しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : 'ゴミ予定を更新できませんでした。');
    } finally {
      setUpdatingOccurrence(false);
    }
  };

  const nextSevenDays = snapshot.upcomingWasteDates
    .filter((occurrence) => occurrence.date >= localDateFromDate(new Date()))
    .sort((left, right) => left.date.localeCompare(right.date))
    .slice(0, 8);

  return (
    <Page>
      <Text accessibilityRole="button" onPress={() => router.back()} style={styles.back}>‹  戻る</Text>
      <ScreenHeading eyebrow="WASTE DAY" title="ゴミ収集日" description="ゴミの種類を検索して選び、曜日や周期を登録します。" />
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}

      <WasteScheduleEditor key={editing?.id ?? 'new'} initial={editing} onSubmit={save} onCancel={editing ? () => setEditing(undefined) : undefined} disabled={saving} />
      {message ? <Text accessibilityLiveRegion="polite" style={message.includes('しました') ? styles.success : styles.error}>{message}</Text> : null}

      <SectionHeading title="登録済み" trailing={<Text style={styles.count}>{snapshot.wasteSchedules.length}種類</Text>} />
      {snapshot.wasteSchedules.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>ゴミの曜日はまだありません</Text><Text style={styles.body}>収集区分と曜日を追加すると、次の収集日を表示します。</Text></Card>
      ) : snapshot.wasteSchedules.map((schedule) => (
        <Card key={schedule.id} style={styles.scheduleCard}>
          <View style={styles.scheduleCopy}>
            <Text style={styles.scheduleName}>{schedule.label}</Text>
            <Text style={styles.days}>{wasteScheduleDescription(schedule)}</Text>
          </View>
          <View style={styles.actions}>
            <AppButton title="編集" onPress={() => { setEditing(schedule); setMessage(null); }} variant="secondary" disabled={saving} compact />
            <AppButton title="削除" onPress={() => void remove(schedule.id)} variant="danger" disabled={saving} compact />
          </View>
        </Card>
      ))}

      <AccordionSection title="次の収集日" expanded={expandedUpcoming} onToggle={() => setExpandedUpcoming((value) => !value)}>
      {nextSevenDays.length === 0 ? <Card><Text style={styles.body}>表示できる収集日はありません。曜日を登録してください。</Text></Card> : nextSevenDays.map((occurrence) => (
        <Card key={`${occurrence.scheduleId}-${occurrence.date}`} style={styles.occurrence}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <Text style={styles.occurrenceLabel}>{occurrence.label}</Text>
          </View>
          <AppButton title="今回は表示しない" onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, true)} variant="quiet" disabled={updatingOccurrence} compact />
        </Card>
      ))}
      </AccordionSection>

      <SectionHeading title="非表示にしたゴミ予定" trailing={<Text style={styles.count}>{snapshot.hiddenWasteDates.length}件</Text>} />
      {snapshot.hiddenWasteDates.length === 0 ? (
        <Card><Text style={styles.body}>非表示にした予定はありません。</Text></Card>
      ) : snapshot.hiddenWasteDates.map((occurrence) => (
        <Card key={`${occurrence.scheduleId}-${occurrence.date}`} style={styles.occurrence}>
          <View style={styles.occurrenceCopy}>
            <Text style={styles.occurrenceDate}>{formatJapaneseDate(occurrence.date, { weekday: true })}</Text>
            <Text style={styles.occurrenceLabel}>{occurrence.label}</Text>
          </View>
          <AppButton title="再表示" onPress={() => void setOccurrenceHidden(occurrence.scheduleId, occurrence.date, false)} variant="secondary" disabled={updatingOccurrence} compact />
        </Card>
      ))}
    </Page>
  );
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  count: { color: palette.muted, fontSize: 12 },
  scheduleCard: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  scheduleCopy: { flex: 1, gap: 4 },
  scheduleName: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  days: { color: palette.muted, fontSize: 12 },
  actions: { flexDirection: 'row', gap: 6 },
  occurrence: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  occurrenceCopy: { flex: 1, gap: 4 },
  occurrenceDate: { color: palette.accent, fontSize: 14, fontWeight: '700' },
  occurrenceLabel: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
  success: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
