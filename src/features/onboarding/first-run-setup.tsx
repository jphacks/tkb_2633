import { useState } from 'react';
import { Pressable, StyleSheet, Switch, Text, View } from 'react-native';
import { useSQLiteContext } from 'expo-sqlite';

import { AppMark } from '@/components/app-mark';
import { AppButton, ChoiceChip, palette } from '@/components/planner-ui';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import type { Weekday } from '@/domain/shared/types';
import { completeFirstSetup, nextInitialDateChoice } from '@/platform/storage/repository';
import { ExpoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';
import type { PlannerSnapshot } from '@/platform/storage/repository';

const modeOptions: { id: FrequencyMode; title: string }[] = [
  { id: 'frequent', title: 'こまめ' },
  { id: 'balanced', title: '普通' },
  { id: 'relaxed', title: '最低限' },
];

const weekdayOptions: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const notificationGateway = new ExpoLocalNotificationGateway();

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
  const [notificationsEnabled, setNotificationsEnabled] = useState(snapshot.settings.notificationsEnabled);
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

  const toggleNotifications = async (enabled: boolean) => {
    setError(null);
    if (!enabled) {
      setNotificationsEnabled(false);
      return;
    }
    try {
      const granted = await notificationGateway.requestPermission();
      setNotificationsEnabled(granted);
      if (!granted) setError('通知は有効になりませんでした。端末の設定から許可できます。');
    } catch {
      setError('通知の許可を確認できませんでした。設定から後で変更できます。');
    }
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
      await completeFirstSetup(database, { frequencyMode: mode, restDays, enabledChoreIds: [...enabledChoreIds], previousDates, notificationsEnabled });
      await onComplete();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '初回設定を保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const stepTitle = ['家事の頻度', '休日', '担当する家事', '前回の実施時期'][step];
  const enabledChores = snapshot.chores.filter((chore) => enabledChoreIds.has(chore.id));

  return (
    <View style={styles.container}>
      <View style={styles.brandBar}>
        <AppMark size={44} />
        <Text style={styles.brandName}>家事スケジュール</Text>
      </View>
      <View style={styles.progressRow}>
        {[0, 1, 2, 3].map((index) => <View key={index} style={[styles.progressDot, index <= step && styles.progressDotActive]} />)}
      </View>
      <Text style={styles.eyebrow}>初期設定を行います · {step + 1} / 4</Text>
      <Text style={styles.title}>{step === 0 ? '今日を整えて、\n明日を軽やかに。' : stepTitle === '休日' ? '休日を教えてください。' : `${stepTitle}を設定`}</Text>
      {step === 0 ? (
        <>
          <Text style={styles.body}>いつもの家事頻度を教えてください。あとからいつでも変更できます。</Text>
          <View style={styles.modeList}>
            {modeOptions.map((option) => (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: mode === option.id }}
                onPress={() => setMode(option.id)}
                style={[styles.modeOption, mode === option.id && styles.modeSelected]}>
                <View style={[styles.checkbox, mode === option.id && styles.checkboxSelected]}>{mode === option.id ? <Text style={styles.check}>✓</Text> : null}</View>
                <View style={styles.modeCopy}>
                  <Text style={[styles.modeTitle, mode === option.id && styles.selectedText]}>{option.title}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      {step === 1 ? (
        <>
          <Text style={styles.body}>家事を行いやすい曜日を選んでください。複数選択できます。</Text>
          <View style={styles.weekdayList}>
            {weekdayOptions.map((day) => {
              const selected = restDays.includes(day.id);
              return (
                <Pressable key={day.id} accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={() => toggleRestDay(day.id)} style={[styles.weekdayOption, selected && styles.weekdaySelected]}>
                  <View style={[styles.checkbox, selected && styles.checkboxSelected]}>{selected ? <Text style={styles.check}>✓</Text> : null}</View>
                  <Text style={styles.weekdayName}>{day.label}曜日</Text>
                </Pressable>
              );
            })}
          </View>
          <Text style={styles.hint}>休日を選ばない場合、休日を優先した日程調整は行いません。</Text>
        </>
      ) : null}

      {step === 2 ? (
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

      {step === 3 ? (
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
          <View style={styles.notificationCard}>
            <View style={styles.notificationCopy}>
              <Text style={styles.label}>家事の通知を受け取る</Text>
              <Text style={styles.hint}>オンにすると端末の通知許可を確認します。通知時刻は設定画面から変更できます。</Text>
            </View>
            <Switch value={notificationsEnabled} onValueChange={(value) => void toggleNotifications(value)} />
          </View>
        </>
      ) : null}

      {error ? <Text style={styles.error}>{error}</Text> : null}
      <View style={styles.footer}>
        {step > 0 ? <AppButton title="戻る" onPress={() => setStep((current) => current - 1)} variant="quiet" compact /> : null}
        {step < 3 ? (
          <AppButton title="次へ" onPress={() => setStep((current) => current + 1)} />
        ) : (
          <View style={styles.finishButtons}>
            <AppButton title="設定して始める" onPress={() => void saveSetup(false)} disabled={saving} />
            <AppButton title="前回の時期はスキップ" onPress={() => void saveSetup(true)} variant="secondary" compact disabled={saving} />
          </View>
        )}
      </View>
      <Text style={styles.disclaimer}>周期の初期値は調整用のたたき台です。家事ごとに変更できます。</Text>
    </View>
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
  container: { gap: 16 },
  brandBar: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 11, marginBottom: 2 },
  brandName: { color: palette.ink, fontSize: 20, fontWeight: '800' },
  progressRow: { flexDirection: 'row', gap: 6 },
  progressDot: { flex: 1, height: 4, borderRadius: 2, backgroundColor: palette.border },
  progressDotActive: { backgroundColor: palette.accent },
  eyebrow: { color: palette.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.2 },
  title: { color: palette.ink, fontSize: 25, lineHeight: 35, fontWeight: '800', marginTop: -7 },
  body: { color: palette.muted, fontSize: 14, lineHeight: 22, marginTop: -7 },
  label: { color: palette.ink, fontSize: 14, fontWeight: '700', marginTop: 2 },
  modeList: { gap: 9, marginTop: 15 },
  modeOption: { minHeight: 66, flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-start', gap: 12, borderWidth: 1, borderColor: palette.accent, borderRadius: 15, backgroundColor: '#FFFFFF', paddingHorizontal: 13, paddingVertical: 11 },
  modeSelected: { backgroundColor: palette.accentSoft },
  modeCopy: { gap: 3 },
  modeTitle: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  selectedText: { color: palette.accent },
  weekdayList: { gap: 9, marginTop: 13 },
  weekdayOption: { minHeight: 62, flexDirection: 'row', alignItems: 'center', gap: 13, borderRadius: 15, borderWidth: 1, borderColor: palette.accent, backgroundColor: '#FFFFFF', paddingHorizontal: 15 },
  weekdaySelected: { backgroundColor: palette.accentSoft },
  weekdayName: { color: palette.ink, fontSize: 15, fontWeight: '600' },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  notificationCard: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 12, borderRadius: 13, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, marginTop: 4 },
  notificationCopy: { flex: 1, gap: 4 },
  choreList: { gap: 7 },
  choreRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingVertical: 9 },
  choreCopy: { flex: 1, gap: 3, paddingRight: 10 },
  choreName: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  choreCategory: { color: palette.muted, fontSize: 11 },
  checkbox: { width: 22, height: 22, borderRadius: 7, borderWidth: 1.5, borderColor: palette.accent, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  check: { color: '#FFFFFF', fontSize: 13, fontWeight: '800' },
  previousCard: { gap: 9, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border, paddingBottom: 12 },
  previousName: { color: palette.ink, fontSize: 14, fontWeight: '600' },
  error: { color: palette.warning, fontSize: 13 },
  footer: { flexDirection: 'row', justifyContent: 'flex-end', alignItems: 'center', gap: 8, marginTop: 5 },
  finishButtons: { flex: 1, gap: 8 },
  disclaimer: { color: palette.muted, fontSize: 11, lineHeight: 16, textAlign: 'center' },
});
