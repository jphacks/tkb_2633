import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, StatusBadge, palette } from '@/components/planner-ui';
import type { ChoreDefinition, ChoreLoad, LaundryDryingPreference } from '@/domain/chores/types';
import { formatJapaneseDate, localDateFromDate, localDateFromISODateTime } from '@/domain/scheduling/local-date';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore, recordIncompleteChore, replaceChoreDependencies, setChoreAssignments, updateChoreDefinition } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';

const loadOptions: { id: ChoreLoad; label: string }[] = [
  { id: 'light', label: '軽い' }, { id: 'normal', label: '普通' }, { id: 'heavy', label: '重い' },
];

export default function ChoreDetailScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const choreId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { snapshot, loading, error: loadError, refresh, database } = usePlannerData();
  const chore = snapshot?.chores.find((item) => item.id === choreId);

  if (loading || !snapshot) return <Page><ScreenHeading eyebrow="CHORE DETAIL" title="家事の詳細" description="データを読み込んでいます。" /></Page>;
  if (!chore) return <Page><ScreenHeading eyebrow="CHORE DETAIL" title="家事が見つかりません" /><AppButton title="家事一覧へ" onPress={() => router.replace('/chores')} /></Page>;

  return <ChoreDetailContent key={chore.id} chore={chore} snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} />;
}

function ChoreDetailContent({
  chore,
  snapshot,
  loadError,
  refresh,
  database,
}: {
  chore: ChoreDefinition;
  snapshot: PlannerSnapshot;
  loadError: string | null;
  refresh: () => Promise<void>;
  database: SQLiteDatabase;
}) {
  const [cycleText, setCycleText] = useState(String(chore.recommendedCycleDays ?? chore.frequencyDaysByMode[snapshot.settings.frequencyMode]));
  const [radiusText, setRadiusText] = useState(String(chore.windowRadiusDays));
  const [load, setLoad] = useState<ChoreLoad>(chore.load);
  const [holidayPriority, setHolidayPriority] = useState(chore.holidayPriority);
  const [dryingPreference, setDryingPreference] = useState<LaundryDryingPreference>(chore.laundryDryingPreference ?? 'either');
  const [enabled, setEnabled] = useState(chore.enabled);
  const [assignedMemberIds, setAssignedMemberIds] = useState<string[]>(snapshot.assignments.find((item) => item.choreId === chore.id)?.memberIds ?? []);
  const [predecessorIds, setPredecessorIds] = useState<string[]>(snapshot.dependencies.filter((item) => item.successorChoreId === chore.id).map((item) => item.predecessorChoreId));
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const entries = snapshot.scheduleEntries.filter((entry) => entry.choreId === chore.id);
  const currentEntry = entries.find((entry) => entry.status === 'overdue' || entry.status === 'inWindow' || entry.status === 'initialPending') ?? entries[0];
  const state = snapshot.states.find((item) => item.choreId === chore.id);
  const previousCompletion = snapshot.completions.find((item) => item.choreId === chore.id && item.outcome === 'completed');
  const latestCompletion = state?.lastCompletedDate ?? (previousCompletion ? localDateFromISODateTime(previousCompletion.completedAt) : undefined);

  const toggleAssignee = (memberId: string) => {
    setAssignedMemberIds((current) => current.includes(memberId)
      ? current.filter((id) => id !== memberId)
      : [...current, memberId]);
  };

  const togglePredecessor = (predecessorId: string) => {
    setPredecessorIds((current) => current.includes(predecessorId)
      ? current.filter((id) => id !== predecessorId)
      : [...current, predecessorId]);
  };

  const save = async () => {
    const cycleDays = cycleText.trim() ? Number(cycleText) : undefined;
    const windowRadiusDays = Number(radiusText);
    if (cycleDays !== undefined && (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 3650)) {
      setMessage('周期は1〜3650日の整数で入力してください。');
      return;
    }
    if (!Number.isInteger(windowRadiusDays) || windowRadiusDays < 0 || windowRadiusDays > 7) {
      setMessage('期間幅は±0〜±7日の整数で入力してください。');
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      await replaceChoreDependencies(database, chore.id, predecessorIds);
      await setChoreAssignments(database, chore.id, assignedMemberIds);
      const updated: ChoreDefinition = {
        ...chore,
        enabled,
        load,
        holidayPriority,
        laundryDryingPreference: chore.category === '洗濯' ? dryingPreference : chore.laundryDryingPreference,
        windowRadiusDays,
        recommendedCycleDays: cycleDays,
      };
      await updateChoreDefinition(database, updated);
      await refresh();
      setMessage('設定を保存しました。予定も更新しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const finish = async () => {
    if (!currentEntry) return;
    setSaving(true);
    setMessage(null);
    try {
      const inserted = await completeChore(database, currentEntry);
      setMessage(inserted ? '完了を記録し、次の周期を作成しました。' : 'この予定はすでに完了しています。');
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '完了を記録できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const recordIncomplete = async () => {
    if (!currentEntry || currentEntry.windowStart > localDateFromDate(new Date())) return;
    setSaving(true);
    setMessage(null);
    try {
      const recorded = await recordIncompleteChore(database, currentEntry);
      setMessage(recorded ? '未完了を記録し、予定を再計算しました。' : 'この予定はすでに完了として記録されています。');
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '未完了を記録できませんでした');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹  家事一覧</Text></Pressable>
      <ScreenHeading eyebrow={chore.category.toUpperCase()} title={chore.name} description={chore.description} />
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}

      <Card style={styles.nextCard}>
        <View style={styles.statusRow}>
          <Text style={styles.cardEyebrow}>次の実施期間</Text>
          {currentEntry ? <StatusBadge status={currentEntry.status} /> : null}
        </View>
        <Text style={styles.period}>{currentEntry ? `${formatJapaneseDate(currentEntry.windowStart)}〜${formatJapaneseDate(currentEntry.windowEnd)}` : '現在、予定はありません'}</Text>
        {currentEntry?.status === 'overdue' ? <Text style={styles.overdue}>推奨期間から{currentEntry.overdueDays ?? 0}日経過 · {currentEntry.overdueCycles ?? 1}周期分</Text> : null}
        <AppButton title="完了にする" onPress={() => void finish()} disabled={!currentEntry || saving} />
        <AppButton
          title="未完了を記録"
          onPress={() => void recordIncomplete()}
          disabled={!currentEntry || currentEntry.windowStart > localDateFromDate(new Date()) || saving}
          variant="secondary"
        />
        {currentEntry && currentEntry.windowStart > localDateFromDate(new Date()) ? (
          <Text style={styles.body}>未完了の記録は実施期間が始まると選べます。</Text>
        ) : null}
      </Card>

      <Card>
        <SectionHeading title="家事の手順" />
        {chore.instructions.length > 0 ? chore.instructions.map((step, index) => (
          <View key={`${index}-${step}`} style={styles.stepRow}>
            <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        )) : <Text style={styles.body}>手順はまだ登録されていません。</Text>}
      </Card>

      <Card>
        <SectionHeading title="必要な道具" />
        <View style={styles.chipRow}>{chore.tools.length > 0 ? chore.tools.map((tool) => <View key={tool} style={styles.toolChip}><Text style={styles.toolText}>{tool}</Text></View>) : <Text style={styles.body}>道具は特にありません。</Text>}</View>
      </Card>

      {chore.cautions.length > 0 ? (
        <Card style={styles.cautionCard}>
          <Text style={styles.cautionTitle}>注意事項</Text>
          {chore.cautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </Card>
      ) : null}

      <Card>
        <SectionHeading title="個別設定" />
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>家事を有効にする</Text><Text style={styles.body}>無効にしても完了履歴は残ります。</Text></View>
          <Switch value={enabled} onValueChange={setEnabled} />
        </View>
        <View style={styles.fieldRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>周期</Text><Text style={styles.body}>頻度モードの初期値は{chore.frequencyDaysByMode[snapshot.settings.frequencyMode]}日です。</Text></View>
          <View style={styles.numberField}><TextInput value={cycleText} onChangeText={setCycleText} keyboardType="number-pad" style={styles.numberInput} accessibilityLabel="家事周期の日数" /><Text style={styles.unit}>日</Text></View>
        </View>
        <View style={styles.fieldRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>実施期間の幅</Text><Text style={styles.body}>基準日から前後に何日広げるか</Text></View>
          <View style={styles.numberField}><Text style={styles.unit}>±</Text><TextInput value={radiusText} onChangeText={setRadiusText} keyboardType="number-pad" style={styles.numberInput} accessibilityLabel="実施期間の日数幅" /><Text style={styles.unit}>日</Text></View>
        </View>
        <View style={styles.settingBlock}>
          <Text style={styles.settingTitle}>負荷</Text>
          <View style={styles.chipRow}>{loadOptions.map((option) => <ChoiceChip key={option.id} label={option.label} selected={load === option.id} onPress={() => setLoad(option.id)} />)}</View>
        </View>
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}><Text style={styles.settingTitle}>休日を優先</Text><Text style={styles.body}>実施期間に設定した休日を含めます。</Text></View>
          <Switch value={holidayPriority} onValueChange={setHolidayPriority} />
        </View>
        {chore.category === '洗濯' ? (
          <View style={styles.settingBlock}>
            <Text style={styles.settingTitle}>基本の干し方</Text>
            <View style={styles.chipRow}>
              <ChoiceChip label="どちらでも" selected={dryingPreference === 'either'} onPress={() => setDryingPreference('either')} />
              <ChoiceChip label="外干し" selected={dryingPreference === 'outdoors'} onPress={() => setDryingPreference('outdoors')} />
              <ChoiceChip label="部屋干し" selected={dryingPreference === 'indoors'} onPress={() => setDryingPreference('indoors')} />
            </View>
            <Text style={styles.body}>希望は端末に保存します。天気取得や天気に応じた切り替えは未接続です。</Text>
          </View>
        ) : null}
        <View style={styles.settingBlock}>
          <Text style={styles.settingTitle}>担当する人</Text>
          {snapshot.members.length === 0 ? <Text style={styles.body}>設定から同居人を追加できます。</Text> : (
            <View style={styles.chipRow}>{snapshot.members.map((member) => <ChoiceChip key={member.id} label={member.displayName} selected={assignedMemberIds.includes(member.id)} onPress={() => toggleAssignee(member.id)} />)}</View>
          )}
          <AppButton title="家族・同居人を設定" onPress={() => router.push('/settings')} variant="quiet" compact />
        </View>
        <View style={styles.settingBlock}>
          <Text style={styles.settingTitle}>この家事の前に行う家事</Text>
          <Text style={styles.body}>選択した家事の提案日より前には配置しません。</Text>
          <View style={styles.chipRow}>
            {snapshot.chores.filter((item) => item.id !== chore.id && item.enabled).map((item) => (
              <ChoiceChip key={item.id} label={item.name} selected={predecessorIds.includes(item.id)} onPress={() => togglePredecessor(item.id)} />
            ))}
          </View>
        </View>
        {latestCompletion ? (
          <View style={styles.lastDone}><Text style={styles.lastDoneLabel}>前回の完了</Text><Text style={styles.lastDoneDate}>{formatJapaneseDate(latestCompletion, { year: true })}{state?.lastCompletedEstimated ? 'ごろ（概算）' : ''}</Text></View>
        ) : <Text style={styles.body}>前回の実施時期は未登録です。初回の予定として負荷を分けて配置します。</Text>}
        {message ? <Text style={message.includes('保存しました') || message.includes('記録し') ? styles.success : styles.error}>{message}</Text> : null}
        <AppButton title={saving ? '保存中…' : '個別設定を保存'} onPress={() => void save()} disabled={saving} />
      </Card>

      <Card>
        <SectionHeading title="記録" />
        <Text style={styles.body}>過去の実施は履歴タブに保存されます。家事を無効にしても記録は削除されません。</Text>
        <AppButton title="この家事の履歴を見る" onPress={() => router.push('/history')} variant="secondary" />
      </Card>

      {chore.category === '家電' ? <Text style={styles.machineNote}>家電のメーカー・型番別情報は、公式資料とAI連携の仕様確定後に追加できる設計です。</Text> : null}
    </Page>
  );
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  nextCard: { backgroundColor: palette.accentSoft, borderColor: '#D8E7DC' },
  statusRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  cardEyebrow: { color: palette.accent, fontSize: 12, fontWeight: '700' },
  period: { color: palette.ink, fontSize: 21, fontWeight: '700' },
  overdue: { color: palette.warning, fontSize: 12, fontWeight: '600' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  stepNumber: { color: palette.accent, fontSize: 12, fontWeight: '800', width: 24, paddingTop: 2 },
  stepText: { flex: 1, color: palette.ink, fontSize: 14, lineHeight: 21 },
  body: { color: palette.muted, fontSize: 12, lineHeight: 19 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  toolChip: { backgroundColor: palette.background, borderRadius: 10, paddingHorizontal: 11, paddingVertical: 8 },
  toolText: { color: palette.ink, fontSize: 12, fontWeight: '600' },
  cautionCard: { backgroundColor: '#FBF5EB', borderColor: '#F0E4CD' },
  cautionTitle: { color: '#8D682E', fontSize: 14, fontWeight: '700' },
  cautionText: { color: '#765A31', fontSize: 13, lineHeight: 20 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 6 },
  settingCopy: { flex: 1, gap: 3 },
  settingTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  numberField: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: palette.border, borderRadius: 11, paddingHorizontal: 8, backgroundColor: palette.background },
  numberInput: { width: 44, paddingVertical: 7, textAlign: 'center', color: palette.ink, fontSize: 15, fontWeight: '700' },
  unit: { color: palette.muted, fontSize: 12 },
  settingBlock: { gap: 8, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  lastDone: { backgroundColor: palette.background, borderRadius: 12, padding: 12, gap: 3 },
  lastDoneLabel: { color: palette.muted, fontSize: 11, fontWeight: '600' },
  lastDoneDate: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  machineNote: { color: palette.muted, fontSize: 11, lineHeight: 17, textAlign: 'center' },
  error: { color: palette.warning, fontSize: 13 },
  success: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
