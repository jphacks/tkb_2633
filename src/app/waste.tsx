import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { router } from 'expo-router';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { AccordionSection } from '@/components/accordion-section';
import { searchWasteTypes } from '@/features/waste/waste-types';
import { formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { Weekday } from '@/domain/shared/types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { deleteWeeklyWasteSchedule, saveWeeklyWasteSchedule, setWasteOccurrenceHidden } from '@/platform/storage/repository';

const weekdays: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];

export default function WasteScreen() {
  const { snapshot, loading, error: loadError, refresh, database } = usePlannerData();
  const [label, setLabel] = useState('');
  const [selectedLabel, setSelectedLabel] = useState<string | null>(null);
  const [selectedWeekdays, setSelectedWeekdays] = useState<Weekday[]>([]);
  const [editingId, setEditingId] = useState<string | undefined>();
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [expandedUpcoming, setExpandedUpcoming] = useState(false);
  const [updatingOccurrence, setUpdatingOccurrence] = useState(false);

  if (loading || !snapshot) return <PlannerLoadState title="ゴミ収集日" message="曜日設定を読み込んでいます。" error={loadError} retry={refresh} />;

  const toggleWeekday = (day: Weekday) => {
    setSelectedWeekdays((current) => current.includes(day)
      ? current.filter((value) => value !== day)
      : [...current, day].sort() as Weekday[]);
  };

  const save = async () => {
    if (!selectedLabel || saving || !selectedWeekdays.length) return;
    setSaving(true);
    setMessage(null);
    try {
      await saveWeeklyWasteSchedule(database, { id: editingId, label: selectedLabel, collectionWeekdays: selectedWeekdays });
      setLabel('');
      setSelectedLabel(null);
      setSelectedWeekdays([]);
      setEditingId(undefined);
      await refresh();
      setMessage('収集曜日を保存しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const edit = (schedule: (typeof snapshot.wasteSchedules)[number]) => {
    setEditingId(schedule.id);
    setLabel(schedule.label);
    setSelectedLabel(schedule.label);
    setSelectedWeekdays([...schedule.collectionWeekdays]);
    setMessage(null);
  };

  const remove = async (scheduleId: string) => {
    if (saving) return;
    setSaving(true);
    setMessage(null);
    try {
      await deleteWeeklyWasteSchedule(database, scheduleId);
      if (editingId === scheduleId) {
        setEditingId(undefined);
        setLabel('');
        setSelectedLabel(null);
        setSelectedWeekdays([]);
      }
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
  const candidates = selectedLabel ? [] : searchWasteTypes(label);

  return (
    <Page>
      <Text accessibilityRole="button" onPress={() => router.back()} style={styles.back}>‹  戻る</Text>
      <ScreenHeading eyebrow="WASTE DAY" title="ゴミ収集日" description="ゴミの種類を検索して選び、収集曜日を登録します。" />
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}

      <Card>
        <SectionHeading title={editingId ? '収集日を編集' : '収集日を追加'} />
        <TextInput
          value={label}
          onChangeText={(value) => { setLabel(value); setSelectedLabel(null); setMessage(null); }}
          placeholder="ゴミの種類を入力（例：かね）"
          placeholderTextColor={palette.muted}
          accessibilityLabel="ゴミの種類"
          style={styles.input}
          returnKeyType="done"
          maxLength={80}
        />
        {selectedLabel ? <View style={styles.selection}><Text style={styles.selectionText}>{selectedLabel}</Text><AppButton title="選び直す" onPress={() => setSelectedLabel(null)} variant="quiet" compact /></View> : label.trim() ? (
          <View style={styles.suggestions}>
            <Text style={styles.label}>候補を選択</Text>
            {candidates.map((candidate) => <Pressable key={candidate.label} accessibilityRole="button" accessibilityLabel={`${candidate.label}を選択`} onPress={() => { setLabel(candidate.label); setSelectedLabel(candidate.label); }} style={styles.candidate}><Text style={styles.candidateText}>{candidate.label}</Text><Text style={styles.candidateArrow}>›</Text></Pressable>)}
            {candidates.length === 0 ? <Pressable accessibilityRole="button" onPress={() => { setLabel(label.trim()); setSelectedLabel(label.trim()); }} style={styles.candidate}><Text style={styles.candidateText}>「{label.trim()}」を使う</Text><Text style={styles.candidateArrow}>›</Text></Pressable> : null}
          </View>
        ) : null}
        <Text style={styles.body}>ひらがな・カタカナでも検索できます。収集区分は自治体の案内に合わせて選んでください。</Text>
        <Text style={styles.label}>収集曜日</Text>
        <View style={styles.chips}>
          {weekdays.map((day) => <ChoiceChip key={day.id} label={`${day.label}曜`} selected={selectedWeekdays.includes(day.id)} onPress={() => toggleWeekday(day.id)} />)}
        </View>
        <AppButton title={saving ? '保存中…' : editingId ? '変更を保存' : '収集日を追加'} onPress={() => void save()} disabled={saving || !selectedLabel || !selectedWeekdays.length} />
        {editingId ? <AppButton title="編集をやめる" onPress={() => { setEditingId(undefined); setLabel(''); setSelectedLabel(null); setSelectedWeekdays([]); }} variant="quiet" compact /> : null}
        {message ? <Text accessibilityLiveRegion="polite" style={message.includes('しました') ? styles.success : styles.error}>{message}</Text> : null}
      </Card>

      <SectionHeading title="登録済み" trailing={<Text style={styles.count}>{snapshot.wasteSchedules.length}種類</Text>} />
      {snapshot.wasteSchedules.length === 0 ? (
        <Card><Text style={styles.emptyTitle}>ゴミの曜日はまだありません</Text><Text style={styles.body}>収集区分と曜日を追加すると、次の収集日を表示します。</Text></Card>
      ) : snapshot.wasteSchedules.map((schedule) => (
        <Card key={schedule.id} style={styles.scheduleCard}>
          <View style={styles.scheduleCopy}>
            <Text style={styles.scheduleName}>{schedule.label}</Text>
            <Text style={styles.days}>{schedule.collectionWeekdays.map((day) => weekdays.find((option) => option.id === day)?.label).filter(Boolean).map((day) => `${day}曜`).join('・')}</Text>
          </View>
          <View style={styles.actions}>
            <AppButton title="編集" onPress={() => edit(schedule)} variant="secondary" disabled={saving} compact />
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
  input: { minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, color: palette.ink, backgroundColor: palette.background },
  label: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
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
  suggestions: { gap: 8 },
  candidate: { minHeight: 46, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  candidateText: { color: palette.ink, fontSize: 14, flex: 1, fontWeight: '600' },
  candidateArrow: { color: palette.accent, fontSize: 23, lineHeight: 25 },
  selection: { borderRadius: 13, backgroundColor: palette.accentSoft, paddingHorizontal: 13, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionText: { flex: 1, color: palette.ink, fontWeight: '700', fontSize: 14 },
  emptyTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
  success: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
