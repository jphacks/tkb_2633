import { useEffect, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, Text, TextInput, View } from 'react-native';
import { AppButton, BackButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette, typography } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import type { Weekday } from '../../../domain/shared/types';
import { useV2DraftLifecycle } from '../v2-ui/use-draft-lifecycle';
import { createPrivatePreferenceEditor } from './preference-editor';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences';
import { snapshotPrivatePlannerPreferences } from './preferences';
import type { PrivatePlannerPreferenceStore } from './preference-store';
import type { ReactNode } from 'react';
import { v2RegionChoices } from '../v2-ui/group-settings-fields';
import { V2Choices, V2TextField } from '../v2-ui/form-controls';

type Session = { store: PrivatePlannerPreferenceStore; defaults: PrivatePlannerPreferences };
const weekdays = ['月', '火', '水', '木', '金', '土', '日'];
export function PrivatePreferenceScreen({ load, onBack, notice, footer }: { load(): Promise<Session>; onBack(): void; notice?: ReactNode; footer?: ReactNode }) {
  const [attempt, setAttempt] = useState(0);
  return <PrivatePreferenceLoader key={attempt} load={load} onBack={onBack} onReload={() => setAttempt(n => n + 1)} notice={notice} footer={footer} />;
}
function PrivatePreferenceLoader({ load, onBack, onReload, notice, footer }: { load(): Promise<Session>; onBack(): void; onReload(): void; notice?: ReactNode; footer?: ReactNode }) {
  const [value, setValue] = useState<{ session: Session; saved: SavedPrivatePlannerPreferences | null } | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let current = true;
    void load().then(async session => {
      if (!current) return; const saved = await session.store.read();
      const defaults = saved ? session.defaults : snapshotPrivatePlannerPreferences(session.defaults);
      if (current) setValue({ session: { ...session, defaults }, saved });
    })
      .catch(() => { if (current) setError(true); });
    return () => { current = false; };
  }, [load]);
  if (value) return <PrivatePreferenceEditor {...value} onBack={onBack} onReload={onReload} notice={notice} footer={footer} />;
  return <Page>{notice}<BackButton onPress={onBack} /><ScreenHeading title="本人の実施可能時間帯" />
    {error ? <Card><Text accessibilityRole="alert" style={typography.body}>本人の保存済み設定を読み込めませんでした。データは保持しています。</Text>
      <AppButton title="本人の設定を再読込" onPress={onReload} /></Card> : <ActivityIndicator color={palette.accent} />}</Page>;
}

function PrivatePreferenceEditor({ session, saved, onBack, onReload, notice, footer }: { session: Session; saved: SavedPrivatePlannerPreferences | null; onBack(): void; onReload(): void; notice?: ReactNode; footer?: ReactNode }) {
  const [store] = useState(() => createPrivatePreferenceEditor({ store: session.store, saved, defaults: session.defaults }));
  const { snapshot: state, navigateAfterSave } = useV2DraftLifecycle(store); const [reloadReview, setReloadReview] = useState(false);
  const raw = state.raw; const [regionSearch, setRegionSearch] = useState(''); const regions = v2RegionChoices(regionSearch, raw.timeZone);
  const change = (patch: Partial<typeof raw>) => store.change(value => ({ ...value, ...patch }));
  const changeBand = (id: number, field: 'start' | 'end', text: string) => store.change(value => ({ ...value, bands: value.bands.map(band => band.id === id ? { ...band, [field]: text } : band) }));
  const back = () => { void navigateAfterSave(onBack); };
  return <Page>{notice}<BackButton onPress={back} />
    <ScreenHeading title="本人の実施可能時間帯" description="この端末の本人向け推奨に使う設定です。他のメンバーには公開されません。" />
    <Text accessibilityLiveRegion="polite" style={typography.caption}>{state.status.phase === 'saving' ? 'この端末に保存中…' : state.status.phase === 'pending' ? '入力した変更を保存待ちです。'
      : state.hasDraft ? '未保存の入力があります。' : state.revision > 0 ? 'この端末に保存済み' : '時間帯は未設定です。入力した内容は自動で保存されます。'}</Text>
    {state.validation ? <Text accessibilityRole="alert" style={styles.error}>{state.validation}</Text> : null}
    {state.status.error ? <Card><Text accessibilityRole="alert" style={styles.error}>{state.status.error}</Text>
      <AppButton title="保存を再試行" onPress={() => { void store.flush(); }} /></Card> : null}
    {state.navigationBlocked ? <Card><Text style={typography.body}>未保存の入力を修正するか、未保存の分を破棄して戻れます。</Text>
      <AppButton title="未保存の入力を破棄して戻る" variant="secondary" onPress={() => { store.discardDraft(); back(); }} /></Card> : null}
    <Card><SectionHeading title="本人の地域" />
      <Text style={typography.body}>現在の地域：{raw.timeZone}</Text>
      <V2TextField label="本人の地域を検索" value={regionSearch} onChangeText={setRegionSearch} placeholder="東京、ニューヨーク" />
      <V2Choices label="本人の地域" choices={regions.choices} value={raw.timeZone} onChange={timeZone => change({ timeZone })} />
      {!regions.total ? <Text style={typography.caption}>一致する地域がありません。都市名で検索してください。</Text> : regions.total > 8 ? <Text style={typography.caption}>入力を追加すると地域を絞り込めます。</Text> : null}
      <Text style={typography.caption}>時刻はここで選んだ地域を基準にします。</Text>
      <SectionHeading title="本人の休日" level="subsection" />
      <View style={styles.choices}>{weekdays.map((label, index) => {
        const day = index + 1 as Weekday;
        return <ChoiceChip key={day} label={label} selected={raw.restDays.includes(day)} onPress={() => store.change(value => ({ ...value,
          restDays: value.restDays.includes(day) ? value.restDays.filter(selected => selected !== day) : [...value.restDays, day] }))} />;
      })}</View>
      <SectionHeading title="本人の1日あたりの負荷上限" level="subsection" />
      <View style={styles.limits}><Text style={typography.label}>重い家事</Text><NumberInputField accessibilityLabel="本人の重い家事の上限" suffix="件" value={raw.heavy}
        onChangeText={text => change({ heavy: text })} onBlur={() => { void store.flush(); }} maxLength={2} /></View>
      <View style={styles.limits}><Text style={typography.label}>普通の家事</Text><NumberInputField accessibilityLabel="本人の普通の家事の上限" suffix="件" value={raw.normal}
        onChangeText={text => change({ normal: text })} onBlur={() => { void store.flush(); }} maxLength={2} /></View>
    </Card>
    <SectionHeading title="自動移動を許可する時間帯" />
    <Text style={typography.caption}>未設定の曜日は自動移動しません。開始・終了を入力してください。日をまたぐ場合は日ごとに分けます。</Text>
    {weekdays.map((label, index) => { const day = index + 1 as Weekday; const bands = raw.bands.filter(band => band.weekday === day);
      return <Card key={day}><SectionHeading title={`${label}曜日`} level="subsection" />
        {bands.map((band, position) => <View key={band.id} style={styles.band}>
          <View style={styles.times}><TextInput accessibilityLabel={`${label}曜日${position + 1}の開始`} placeholder="HH:mm" value={band.start} maxLength={5}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'} autoCorrect={false} autoComplete="off" onChangeText={text => changeBand(band.id, 'start', text)}
            onBlur={() => { void store.flush(); }} style={[styles.input, styles.time]} underlineColorAndroid="transparent" />
          <Text style={typography.body}>〜</Text><TextInput accessibilityLabel={`${label}曜日${position + 1}の終了`} placeholder="HH:mm" value={band.end} maxLength={5}
            keyboardType={Platform.OS === 'ios' ? 'numbers-and-punctuation' : 'default'} autoCorrect={false} autoComplete="off" onChangeText={text => changeBand(band.id, 'end', text)}
            onBlur={() => { void store.flush(); }} style={[styles.input, styles.time]} underlineColorAndroid="transparent" /></View>
          <AppButton title={`${label}曜日${position + 1}の時間帯を削除`} variant="quiet" compact onPress={() => store.change(value => ({ ...value, bands: value.bands.filter(row => row.id !== band.id) }))} />
        </View>)}
        <AppButton title={`${label}曜日の時間帯を追加`} variant="secondary" compact disabled={raw.bands.length >= 56} onPress={() => store.addBand(day)} />
      </Card>;
    })}
    <AppButton title="保存済みの本人設定を再読込" variant="quiet" onPress={() => state.hasDraft ? setReloadReview(true) : onReload()} />
    {reloadReview ? <Card><Text style={typography.body}>未保存の入力を破棄して、保存済みの設定を読み込みますか？</Text>
      <AppButton title="未保存の入力を破棄して再読込" onPress={() => { store.discardDraft(); void store.flush().then(success => { if (success) onReload(); }); }} />
      <AppButton title="編集を続ける" variant="quiet" onPress={() => setReloadReview(false)} /></Card> : null}
    {footer}
  </Page>;
}
const styles = StyleSheet.create({
  input: { fontSize: typography.control.fontSize, color: palette.ink, borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, minHeight: 46, paddingHorizontal: 12, paddingVertical: 9, includeFontPadding: false, backgroundColor: palette.background },
  error: { ...typography.caption, color: palette.warning }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 6 },
  limits: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  band: { gap: 4 }, times: { flexDirection: 'row', alignItems: 'center', gap: 8 }, time: { flex: 1, textAlign: 'center' },
});
