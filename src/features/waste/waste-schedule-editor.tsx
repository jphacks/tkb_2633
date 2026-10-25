import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, SectionHeading, palette } from '@/components/planner-ui';
import { addDays, daysBetween, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate, Weekday } from '@/domain/shared/types';
import type { WasteRecurrence, WasteScheduleInput } from './contracts';
import { nextWasteWeekday, normalizeWasteSchedule, wasteWeekdays } from './schedule-policy';
import { searchWasteTypes } from './waste-types';

/** The same editor is used in first-run setup and settings so the supported modes cannot drift. */
export function WasteScheduleEditor({ initial, onSubmit, onCancel, disabled = false }: {
  initial?: WasteScheduleInput;
  onSubmit: (schedule: WasteScheduleInput) => Promise<void>;
  onCancel?: () => void;
  disabled?: boolean;
}) {
  const today = localDateFromDate(new Date());
  const [query, setQuery] = useState(initial?.label ?? '');
  const [label, setLabel] = useState<string | null>(initial?.label ?? null);
  const [recurrence, setRecurrence] = useState<WasteRecurrence>(initial?.recurrence ?? 'weekly');
  const [weekdays, setWeekdays] = useState<Weekday[]>([...(initial?.collectionWeekdays ?? [])]);
  const [anchorDate, setAnchorDate] = useState<LocalDate | undefined>(initial?.anchorDate);
  const [monthlyDay, setMonthlyDay] = useState(String(initial?.monthlyDay ?? Number(today.slice(-2))));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const candidates = label ? [] : searchWasteTypes(query);
  const locked = disabled || saving;
  const nextDate = weekdays[0] ? nextWasteWeekday(today, weekdays[0]) : undefined;
  const validMonthlyDay = /^\d{1,2}$/.test(monthlyDay) && Number(monthlyDay) >= 1 && Number(monthlyDay) <= 31;
  const canSave = Boolean(label && (recurrence === 'monthly' ? validMonthlyDay : weekdays.length && (recurrence !== 'biweekly' || anchorDate)));

  const changeRecurrence = (value: WasteRecurrence) => {
    if (value === recurrence) return;
    setRecurrence(value);
    setError(null);
    if (value === 'biweekly') {
      setWeekdays(weekdays.slice(0, 1));
      setAnchorDate(nextDate);
    } else setAnchorDate(value === 'monthly' ? today : undefined);
  };
  const toggleWeekday = (day: Weekday) => {
    if (recurrence === 'biweekly') {
      const remove = weekdays.includes(day);
      setWeekdays(remove ? [] : [day]);
      setAnchorDate(remove ? undefined : nextWasteWeekday(today, day));
    } else setWeekdays((current) => current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort());
  };
  const save = async () => {
    if (locked || !canSave || !label) return;
    setSaving(true);
    setError(null);
    try {
      await onSubmit(normalizeWasteSchedule({ id: initial?.id, label, collectionWeekdays: weekdays, recurrence,
        anchorDate, ...(recurrence === 'monthly' ? { monthlyDay: Number(monthlyDay) } : {}) }));
      setQuery(''); setLabel(null); setWeekdays([]); setRecurrence('weekly'); setAnchorDate(undefined);
      setMonthlyDay(String(Number(today.slice(-2))));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '収集日を保存できませんでした。');
    } finally { setSaving(false); }
  };

  return (
    <Card>
      <SectionHeading title={initial ? '収集日を編集' : '収集日を追加'} />
      <TextInput accessibilityLabel="ゴミの種類" value={query} editable={!locked}
        onChangeText={(value) => { setQuery(value); setLabel(null); setError(null); }} maxLength={80}
        placeholder="ゴミの種類を入力（例：かね）" placeholderTextColor={palette.muted} style={styles.input} returnKeyType="done" />
      {label ? (
        <View style={styles.selection}><Text style={styles.selectionText}>{label}</Text><AppButton title="選び直す" onPress={() => setLabel(null)} variant="quiet" compact disabled={locked} /></View>
      ) : query.trim() ? (
        <View style={styles.suggestions}>
          <Text style={styles.label}>候補を選択</Text>
          {candidates.map((candidate) => <Pressable key={candidate.label} accessibilityRole="button" accessibilityLabel={`${candidate.label}を選択`} disabled={locked}
            onPress={() => { setQuery(candidate.label); setLabel(candidate.label); }} style={styles.candidate}>
            <Text style={styles.candidateText}>{candidate.label}</Text><Text style={styles.arrow}>›</Text>
          </Pressable>)}
          {!candidates.length ? <Pressable accessibilityRole="button" disabled={locked} onPress={() => { setQuery(query.trim()); setLabel(query.trim()); }} style={styles.candidate}>
            <Text style={styles.candidateText}>「{query.trim()}」を使う</Text><Text style={styles.arrow}>›</Text>
          </Pressable> : null}
        </View>
      ) : null}
      <Text style={styles.body}>ひらがな・カタカナでも検索できます。自治体の収集区分に合わせて選んでください。</Text>
      <Text style={styles.label}>収集周期</Text>
      <View style={styles.chips}>
        {([['weekly', '毎週'], ['biweekly', '隔週'], ['monthly', '毎月']] as const).map(([id, name]) => (
          <ChoiceChip key={id} label={name} selected={recurrence === id} onPress={() => { if (!locked) changeRecurrence(id); }} />
        ))}
      </View>
      {recurrence === 'monthly' ? (
        <>
          <View style={styles.monthlyRow}><Text style={styles.label}>毎月の収集日</Text>
            <TextInput accessibilityLabel="毎月の収集日" value={monthlyDay} editable={!locked} onChangeText={setMonthlyDay}
              keyboardType="number-pad" maxLength={2} style={[styles.input, styles.dayInput]} /><Text style={styles.label}>日</Text>
          </View>
          <Text style={styles.body}>指定した日がない月は、月末に表示します。</Text>
        </>
      ) : (
        <>
          <Text style={styles.label}>{recurrence === 'biweekly' ? '隔週の曜日（1つ）' : '収集曜日'}</Text>
          <View style={styles.weekdays}>
            {wasteWeekdays.map((day) => <Pressable key={day.id} accessibilityRole="button" accessibilityLabel={`${day.label}曜`}
              accessibilityState={{ selected: weekdays.includes(day.id), disabled: locked }} disabled={locked}
              onPress={() => toggleWeekday(day.id)} style={[styles.weekday, weekdays.includes(day.id) && styles.weekdaySelected]}>
              <Text style={[styles.weekdayText, weekdays.includes(day.id) && styles.weekdaySelectedText]}>{day.label}</Text>
            </Pressable>)}
          </View>
        </>
      )}
      {recurrence === 'biweekly' && nextDate ? (
        <>
          <Text style={styles.label}>次に収集する週</Text>
          <View style={styles.chips}>{[nextDate, addDays(nextDate, 7)].map((date) => <ChoiceChip key={date}
            label={formatJapaneseDate(date, { weekday: true })} selected={Boolean(anchorDate && daysBetween(anchorDate, date) % 14 === 0)}
            onPress={() => { if (!locked) setAnchorDate(date); }} />)}</View>
          <Text style={styles.body}>選んだ日を基準に、2週間ごとに表示します。</Text>
        </>
      ) : null}
      {error ? <Text accessibilityLiveRegion="polite" style={styles.error}>{error}</Text> : null}
      <AppButton title={saving ? '保存中…' : initial ? '変更を保存' : '収集日を追加'} onPress={() => void save()} disabled={locked || !canSave} />
      {onCancel ? <AppButton title="編集をやめる" onPress={onCancel} variant="quiet" compact disabled={locked} /> : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  input: { minHeight: 48, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, color: palette.ink, backgroundColor: palette.background },
  label: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  body: { color: palette.muted, fontSize: 12, lineHeight: 19 },
  error: { color: palette.warning, fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  weekdays: { flexDirection: 'row', gap: 5 },
  weekday: { flex: 1, minHeight: 40, borderWidth: 1, borderColor: palette.border, borderRadius: 20, alignItems: 'center', justifyContent: 'center' },
  weekdaySelected: { backgroundColor: palette.accentSoft, borderColor: palette.accent },
  weekdayText: { color: palette.muted, fontSize: 13, fontWeight: '700' },
  weekdaySelectedText: { color: palette.accent },
  monthlyRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  dayInput: { width: 65, textAlign: 'center' },
  selection: { borderRadius: 13, backgroundColor: palette.accentSoft, paddingHorizontal: 13, minHeight: 46, flexDirection: 'row', alignItems: 'center', gap: 8 },
  selectionText: { flex: 1, color: palette.ink, fontWeight: '700', fontSize: 14 },
  suggestions: { gap: 8 },
  candidate: { minHeight: 46, borderWidth: 1, borderColor: palette.border, borderRadius: 13, paddingHorizontal: 13, paddingVertical: 10, flexDirection: 'row', alignItems: 'center', gap: 10 },
  candidateText: { color: palette.ink, fontSize: 14, flex: 1, fontWeight: '600' },
  arrow: { color: palette.accent, fontSize: 23, lineHeight: 25 },
});
