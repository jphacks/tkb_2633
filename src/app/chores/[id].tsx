import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition, ChoreLoad, LaundryDryingPreference } from '@/domain/chores/types';
import { formatJapaneseDate, localDateFromISODateTime } from '@/domain/scheduling/local-date';
import { usePlannerData } from '@/hooks/use-planner-data';
import { updateChoreDefinition } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';

const loadOptions: { id: ChoreLoad; label: string }[] = [
  { id: 'light', label: '軽い' }, { id: 'normal', label: '普通' }, { id: 'heavy', label: '重い' },
];

export default function ChoreSettingsScreen() {
  const params = useLocalSearchParams<{ id: string }>();
  const choreId = Array.isArray(params.id) ? params.id[0] : params.id;
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const chore = snapshot?.chores.find((item) => item.id === choreId);

  if (loading || !snapshot) return <Page><ScreenHeading title="家事ごとの設定" description="設定を読み込んでいます。" /></Page>;
  if (!chore) return <Page><ScreenHeading title="家事が見つかりません" /><AppButton title="設定へ戻る" onPress={() => router.back()} /></Page>;

  return <ChoreSettingsContent key={chore.id} chore={chore} snapshot={snapshot} error={error} refresh={refresh} saveDefinition={(definition) => updateChoreDefinition(database, definition)} />;
}

function ChoreSettingsContent({
  chore,
  snapshot,
  error,
  refresh,
  saveDefinition,
}: {
  chore: ChoreDefinition;
  snapshot: PlannerSnapshot;
  error: string | null;
  refresh: () => Promise<void>;
  saveDefinition: (definition: ChoreDefinition) => Promise<void>;
}) {
  const [cycleText, setCycleText] = useState(chore.requiresCycleSelection
    ? ''
    : String(chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[snapshot.settings.frequencyMode]));
  const [cycleWasEdited, setCycleWasEdited] = useState(false);
  const [radiusText, setRadiusText] = useState(String(chore.windowRadiusDays));
  const [load, setLoad] = useState<ChoreLoad>(chore.load);
  const [holidayPriority, setHolidayPriority] = useState(chore.holidayPriority);
  const [dryingPreference, setDryingPreference] = useState<LaundryDryingPreference>(chore.laundryDryingPreference ?? 'either');
  const [enabled, setEnabled] = useState(chore.enabled);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const state = snapshot.states.find((item) => item.choreId === chore.id);
  const previousCompletion = snapshot.completions
    .filter((item) => item.choreId === chore.id && item.outcome === 'completed')
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))[0];
  const latestCompletion = state?.lastCompletedDate ?? (previousCompletion ? localDateFromISODateTime(previousCompletion.completedAt) : undefined);

  const save = async () => {
    const cycleDays = cycleText.trim() ? Number(cycleText) : undefined;
    const windowRadiusDays = Number(radiusText);
    if (cycleDays !== undefined && (!Number.isInteger(cycleDays) || cycleDays < 1 || cycleDays > 3650)) {
      setMessage('周期は1〜3650日の整数で入力してください。');
      return;
    }
    if (enabled && chore.requiresCycleSelection && cycleDays === undefined) {
      setMessage('メーカー指定の周期がありません。家事を有効にする前に周期を入力してください。');
      return;
    }
    if (!Number.isInteger(windowRadiusDays) || windowRadiusDays < 0 || windowRadiusDays > 7) {
      setMessage('期間幅は±0〜±7日の整数で入力してください。');
      return;
    }

    setSaving(true);
    setMessage(null);
    try {
      const updated: ChoreDefinition = {
        ...chore,
        enabled: chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined && cycleDays === undefined
          ? false
          : enabled,
        load,
        holidayPriority,
        laundryDryingPreference: chore.category === '洗濯' ? dryingPreference : chore.laundryDryingPreference,
        windowRadiusDays,
        recommendedCycleDays: chore.applianceId
          ? (!cycleWasEdited ? chore.recommendedCycleDays : cycleDays === chore.manufacturerRecommendedIntervalDays ? undefined : cycleDays)
          : (!cycleWasEdited ? chore.recommendedCycleDays : cycleDays === chore.manufacturerRecommendedIntervalDays ? undefined : cycleDays),
        userIntervalDays: chore.applianceId
          ? (!cycleWasEdited ? chore.userIntervalDays : cycleDays === chore.manufacturerRecommendedIntervalDays ? undefined : cycleDays)
          : chore.userIntervalDays,
        requiresCycleSelection: Boolean(chore.applianceCareSource
          && chore.manufacturerRecommendedIntervalDays === undefined
          && (cycleWasEdited ? cycleDays === undefined : chore.userIntervalDays === undefined && chore.recommendedCycleDays === undefined)),
      };
      await saveDefinition(updated);
      await refresh();
      setMessage('設定を保存し、予定を更新しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Page>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹  設定へ戻る</Text></Pressable>
      <ScreenHeading eyebrow={chore.category.toUpperCase()} title={`${chore.name}の設定`} description="この家事の頻度や実施条件を調整できます。" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <Card>
        <SectionHeading title="個別設定" />
        <SectionHeading title="基本" />
        <View style={styles.settingRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.settingTitle}>家事を有効にする</Text>
            <Text style={styles.body}>{chore.requiresCycleSelection ? '周期を設定してから有効にできます。' : '無効にしても完了履歴は残ります。'}</Text>
          </View>
          <Switch value={enabled} onValueChange={setEnabled} disabled={chore.requiresCycleSelection && !cycleText.trim()} />
        </View>
        <View style={styles.fieldRow}>
          <View style={styles.settingCopy}>
            <Text style={styles.settingTitle}>周期</Text>
            <Text style={styles.body}>
              {chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined
                ? 'メーカー指定なし。周期を入力するまでは予定に追加されません。'
                : chore.manufacturerRecommendedIntervalDays !== undefined
                  ? `メーカー推奨：${chore.manufacturerRecommendedIntervalDays}日${(chore.userIntervalDays ?? chore.recommendedCycleDays) !== undefined && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== chore.manufacturerRecommendedIntervalDays ? ` · あなたの設定：${chore.userIntervalDays ?? chore.recommendedCycleDays}日` : ''}`
                  : `頻度モードの初期値は${chore.frequencyDaysByMode[snapshot.settings.frequencyMode]}日です。`}
            </Text>
          </View>
          <View style={styles.numberField}>
            <TextInput
              value={cycleText}
              onChangeText={(value) => { setCycleWasEdited(true); setCycleText(value); if (chore.requiresCycleSelection) setEnabled(Boolean(value.trim())); }}
              keyboardType="number-pad"
              style={styles.numberInput}
              accessibilityLabel="家事周期の日数"
              placeholder={chore.requiresCycleSelection ? '入力' : undefined}
            />
            <Text style={styles.unit}>日</Text>
          </View>
        </View>
        {chore.applianceId && chore.manufacturerRecommendedIntervalDays !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== undefined
          && (chore.userIntervalDays ?? chore.recommendedCycleDays) !== chore.manufacturerRecommendedIntervalDays ? (
            <AppButton title="メーカー推奨に戻す" onPress={() => { setCycleWasEdited(true); setCycleText(String(chore.manufacturerRecommendedIntervalDays)); }} variant="quiet" compact />
          ) : null}

        <SectionHeading title="実施スケジュール" />
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
            <SectionHeading title="洗濯" />
            <Text style={styles.settingTitle}>基本の干し方</Text>
            <View style={styles.chipRow}>
              <ChoiceChip label="どちらでも" selected={dryingPreference === 'either'} onPress={() => setDryingPreference('either')} />
              <ChoiceChip label="外干し" selected={dryingPreference === 'outdoors'} onPress={() => setDryingPreference('outdoors')} />
              <ChoiceChip label="部屋干し" selected={dryingPreference === 'indoors'} onPress={() => setDryingPreference('indoors')} />
            </View>
          </View>
        ) : null}

        <SectionHeading title="前回の実施" />
        {latestCompletion
          ? <Text style={styles.body}>{formatJapaneseDate(latestCompletion, { year: true })}{state?.lastCompletedEstimated ? 'ごろ（概算）' : ''}</Text>
          : <Text style={styles.body}>前回の実施時期は未登録です。</Text>}
        {message ? <Text style={message.includes('保存し') ? styles.success : styles.error}>{message}</Text> : null}
        <AppButton title={saving ? '保存中…' : '個別設定を保存'} onPress={() => void save()} disabled={saving} />
        <AppButton title="この家事の履歴を見る" onPress={() => router.push({ pathname: '/history', params: { choreId: chore.id } })} variant="secondary" />
      </Card>
    </Page>
  );
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  body: { color: palette.muted, fontSize: 12, lineHeight: 19 },
  settingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 6 },
  settingCopy: { flex: 1, gap: 3 },
  settingTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  fieldRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  numberField: { flexDirection: 'row', alignItems: 'center', gap: 4, borderWidth: 1, borderColor: palette.border, borderRadius: 11, paddingHorizontal: 8, backgroundColor: palette.background },
  numberInput: { width: 44, paddingVertical: 7, textAlign: 'center', color: palette.ink, fontSize: 15, fontWeight: '700' },
  unit: { color: palette.muted, fontSize: 12 },
  settingBlock: { gap: 8, paddingVertical: 7, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  error: { color: palette.warning, fontSize: 13 },
  success: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
