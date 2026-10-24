import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

import { AppButton, Card, ChoiceChip, palette } from '@/components/planner-ui';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { Weekday } from '@/domain/shared/types';
import { completeFirstSetup, nextInitialDateChoice } from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';

const modeOptions: { id: FrequencyMode; title: string; detail: string }[] = [
  { id: 'frequent', title: 'こまめ', detail: '短めの周期で提案' },
  { id: 'balanced', title: '適度', detail: '標準的な周期で提案' },
  { id: 'relaxed', title: '少なめ', detail: 'ゆったりした周期で提案' },
];

const weekdayOptions: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];

type PreviousChoice = 'today' | 'week' | 'month' | 'unknown';

export function FirstRunSetup({ snapshot, onComplete }: { snapshot: PlannerSnapshot; onComplete: () => Promise<void> }) {
  const database = useSQLiteContext();
  const [step, setStep] = useState(0);
  const [mode, setMode] = useState(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [enabledChoreIds, setEnabledChoreIds] = useState(() =>
    new Set(snapshot.chores.filter((chore) => chore.enabled).map((chore) => chore.id)),
  );
  const [previousChoices, setPreviousChoices] = useState<Record<string, PreviousChoice>>({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggleRestDay = (weekday: Weekday) => {
    setRestDays((current) => current.includes(weekday)
      ? current.filter((item) => item !== weekday)
      : [...current, weekday].sort() as Weekday[]);
  };

  const toggleChore = (choreId: string) => {
    setEnabledChoreIds((current) => {
      const next = new Set(current);
      if (next.has(choreId)) next.delete(choreId);
      else next.add(choreId);
      return next;
    });
  };

  const saveSetup = async (skipPreviousDates: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const today = localDateFromDate(new Date());
      const previousDates: Record<string, { date?: `${number}-${number}-${number}`; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' }> = {};
      for (const choreId of enabledChoreIds) {
        const choice = skipPreviousDates ? 'unknown' : previousChoices[choreId] ?? 'unknown';
        const result = nextInitialDateChoice(today, choice);
        previousDates[choreId] = choice === 'unknown' && skipPreviousDates
          ? { unknownReason: 'skipped' }
          : result;
      }
      await completeFirstSetup(database, { frequencyMode: mode, restDays, enabledChoreIds: [...enabledChoreIds], previousDates });
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初回設定を保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const stepTitle = ['生活リズム', '担当する家事', '前回の実施時期'][step];
  const enabledChores = snapshot.chores.filter((chore) => enabledChoreIds.has(chore.id));

  return (
    <Card style={styles.card}>
      <View style={styles.progressRow}>
        {[0, 1, 2].map((index) => <View key={index} style={[styles.progressDot, index <= step && styles.progressDotActive]} />)}
      </View>
      <Text style={styles.eyebrow}>はじめに · {step + 1} / 3</Text>
      <Text style={styles.title}>{stepTitle}を設定</Text>
      {step === 0 ? (
        <>
          <Text style={styles.body}>家事をする頻度と、休みの日を教えてください。あとからいつでも変更できます。</Text>
          <Text style={styles.label}>家事の頻度</Text>
          <View style={styles.modeList}>
            {modeOptions.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === option.id }}
                onPress={() => setMode(option.id)}
                style={[styles.modeOption, mode === option.id && styles.modeSelected]}>
                <View style={styles.modeCopy}>
                  <Text style={[styles.modeTitle, mode === option.id && styles.selectedText]}>{option.title}</Text>
                  <Text style={styles.modeDetail}>{option.detail}</Text>
                </View>
                <View style={[styles.radio, mode === option.id && styles.radioSelected]} />
              </Pressable>
            ))}
          </View>
          <Text style={styles.label}>休日</Text>
          <View style={styles.chipRow}>
            {weekdayOptions.map((day) => (
              <ChoiceChip key={day.id} label={day.label} selected={restDays.includes(day.id)} onPress={() => toggleRestDay(day.id)} />
            ))}
          </View>
          <Text style={styles.hint}>初期値は土曜・日曜です。休日を選ばない場合、休日を優先した日程調整は行いません。</Text>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <Text style={styles.body}>自分が行う家事を選びます。いったん全部選び、不要なものを外しても大丈夫です。</Text>
          <View style={styles.choreList}>
            {snapshot.chores.map((chore) => (
              <SetupChoreRow key={chore.id} chore={chore} selected={enabledChoreIds.has(chore.id)} onPress={() => toggleChore(chore.id)} />
            ))}
          </View>
          <AppButton
            title={enabledChoreIds.size === snapshot.chores.length ? '選択をすべて外す' : 'すべて選択'}
            onPress={() => setEnabledChoreIds(enabledChoreIds.size === snapshot.chores.length ? new Set() : new Set(snapshot.chores.map((chore) => chore.id)))}
            variant="quiet"
            compact
          />
        </>
      ) : null}

      {step === 2 ? (
        <>
          <Text style={styles.body}>前回行った時期が分かる家事だけ選んでください。「分からない」やスキップも使えます。</Text>
          {enabledChores.length === 0 ? <Text style={styles.hint}>家事が選ばれていません。あとから家事一覧で有効にできます。</Text> : null}
          <View style={styles.choreList}>
            {enabledChores.map((chore) => (
              <View key={chore.id} style={styles.previousCard}>
                <Text style={styles.previousName}>{chore.name}</Text>
                <View style={styles.chipRow}>
                  {([
                    ['today', '今日'], ['week', '1週間前'], ['month', '1か月前'], ['unknown', '不明'],
                  ] as [PreviousChoice, string][]).map(([choice, label]) => (
                    <ChoiceChip
                      key={choice}
                      label={label}
                      selected={(previousChoices[chore.id] ?? 'unknown') === choice}
                      onPress={() => setPreviousChoices((current) => ({ ...current, [chore.id]: choice }))}
                    />
                  ))}
                </View>
              </View>
            ))}
          </View>
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footer}>
        {step > 0 ? <AppButton title="戻る" onPress={() => setStep((current) => current - 1)} variant="quiet" compact /> : null}
        {step < 2 ? (
          <AppButton title="次へ" onPress={() => setStep((current) => current + 1)} />
        ) : (
          <View style={styles.finishButtons}>
            <AppButton title="設定して始める" onPress={() => void saveSetup(false)} disabled={saving} />
            <AppButton title="前回の時期はスキップ" onPress={() => void saveSetup(true)} variant="secondary" compact disabled={saving} />
          </View>
        )}
      </View>
      <Text style={styles.disclaimer}>周期の初期値は調整用のたたき台です。家事ごとに変更できます。</Text>
    </Card>
  );
}

function SetupChoreRow({ chore, selected, onPress }: { chore: ChoreDefinition; selected: boolean; onPress: () => void }) {
  return (
    <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={onPress} style={styles.choreRow}>
      <View style={styles.choreCopy}>
        <Text style={styles.choreName}>{chore.name}</Text>
        <Text style={styles.choreCategory}>{chore.category} · {chore.estimatedMinutes ? `約${chore.estimatedMinutes}分` : '時間目安なし'}</Text>
      </View>
      <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { padding: 20, gap: 15 },
  progressRow: { flexDirection: 'row', gap: 6 },
  progressDot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: palette.border },
  progressDotActive: { backgroundColor: palette.accent },
  eyebrow: { color: palette.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: palette.ink, fontSize: 21, fontWeight: '700', marginTop: -9 },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20, marginTop: -8 },
  label: { color: palette.ink, fontSize: 14, fontWeight: '700', marginTop: 2 },
  modeList: { gap: 8 },
  modeOption: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.border, borderRadius: 15, padding: 13 },
  modeSelected: { backgroundColor: palette.accentSoft, borderColor: palette.accent },
  modeCopy: { gap: 3 },
  modeTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  modeDetail: { color: palette.muted, fontSize: 12 },
  selectedText: { color: palette.accent },
  radio: { width: 18, height: 18, borderRadius: 9, borderWidth: 1.5, borderColor: palette.border },
  radioSelected: { borderWidth: 5, borderColor: palette.accent },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  choreList: { gap: 7 },
  choreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingVertical: 9 },
  choreCopy: { flex: 1, gap: 3, paddingRight: 10 },
  choreName: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  choreCategory: { color: palette.muted, fontSize: 11 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: palette.border, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  check: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  previousCard: { gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingBottom: 12 },
  previousName: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  error: { color: palette.warning, fontSize: 13 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 4 },
  finishButtons: { flex: 1, gap: 8 },
  disclaimer: { color: palette.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
