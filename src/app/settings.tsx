import { router } from 'expo-router';
import { useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ActivityIndicator, Platform, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { CalendarTaskCountIndicator } from '@/components/calendar-task-count-indicator';
import { AccordionSection } from '@/components/accordion-section';
import { CALENDAR_COUNT_COLOR_OPTIONS } from '@/domain/calendar/count-colors';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import type { CalendarCountDisplayMode, Weekday } from '@/domain/shared/types';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import {
  clearWeatherLocation,
  saveWeatherLocation,
  setNotificationsEnabled,
  updateCalendarCountDisplay,
  updatePlannerSettings,
} from '@/platform/storage/repository';
import type { PlannerSnapshot } from '@/platform/storage/repository';
import { ExpoLocalNotificationGateway } from '@/platform/notifications/expo-local-notification-gateway';

const modeOptions: { id: FrequencyMode; label: string; detail: string }[] = [
  { id: 'frequent', label: 'こまめ', detail: '短めの周期' },
  { id: 'balanced', label: '適度', detail: '標準の周期' },
  { id: 'relaxed', label: '少なめ', detail: 'ゆったり' },
];
const weekdays: { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];
const notificationGateway = new ExpoLocalNotificationGateway();

export default function SettingsScreen() {
  const { snapshot, loading, error: loadError, refresh, database } = usePlannerData();
  if (loading || !snapshot) return <PlannerLoadState title="設定" message="設定を読み込んでいます。" error={loadError} retry={refresh} />;
  return <SettingsContent snapshot={snapshot} loadError={loadError} refresh={refresh} database={database} />;
}

function SettingsContent({ snapshot, loadError, refresh, database }: {
  snapshot: PlannerSnapshot;
  loadError: string | null;
  refresh: (options?: { waitForWeather?: boolean }) => Promise<void>;
  database: SQLiteDatabase;
}) {
  const [mode, setMode] = useState<FrequencyMode>(snapshot.settings.frequencyMode);
  const [restDays, setRestDays] = useState<Weekday[]>(snapshot.settings.restDays as Weekday[]);
  const [heavyLimit, setHeavyLimit] = useState(snapshot.settings.heavyDailyLimit);
  const [normalLimit, setNormalLimit] = useState(snapshot.settings.normalDailyLimit);
  const [calendarCountColors, setCalendarCountColors] = useState(snapshot.settings.calendarCountColors);
  const [calendarCountDisplayMode, setCalendarCountDisplayMode] = useState<CalendarCountDisplayMode>(snapshot.settings.calendarCountDisplayMode);
  const [expandedSections, setExpandedSections] = useState<Set<string>>(new Set());
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [calendarColorsSaving, setCalendarColorsSaving] = useState(false);
  const [calendarColorsMessage, setCalendarColorsMessage] = useState<string | null>(null);
  const [weatherUpdating, setWeatherUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [weatherRegion, setWeatherRegion] = useState(snapshot.settings.weatherLocation?.region ?? '');
  const [weatherSearchEnabled, setWeatherSearchEnabled] = useState(false);
  const [weatherCandidate, setWeatherCandidate] = useState<WeatherRegionCandidate | null>(null);
  const [weatherResultsDismissed, setWeatherResultsDismissed] = useState(false);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [notificationUpdating, setNotificationUpdating] = useState(false);
  const weatherSuggestions = useMunicipalitySuggestions(weatherRegion, weatherSearchEnabled);

  const toggleRestDay = (day: Weekday) => {
    setRestDays((current) => current.includes(day)
      ? current.filter((value) => value !== day)
      : [...current, day].sort() as Weekday[]);
  };

  const toggleSection = (section: string) => {
    setExpandedSections((current) => {
      const next = new Set(current);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  };

  const save = async () => {
    if (!Number.isInteger(heavyLimit) || heavyLimit < 1 || heavyLimit > 10
      || !Number.isInteger(normalLimit) || normalLimit < 1 || normalLimit > 20) {
      setMessage('1日の上限は、重い家事1〜10件・普通の家事1〜20件で設定してください。');
      return;
    }
    setSaving(true);
    setMessage(null);
    try {
      await updatePlannerSettings(database, { frequencyMode: mode, restDays, heavyDailyLimit: heavyLimit, normalDailyLimit: normalLimit });
      await refresh();
      setMessage('設定を保存し、予定を再計算しました。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '保存できませんでした');
    } finally {
      setSaving(false);
    }
  };

  const saveCalendarColors = async () => {
    setCalendarColorsSaving(true);
    setCalendarColorsMessage(null);
    try {
      await updateCalendarCountDisplay(database, { colors: calendarCountColors, displayMode: calendarCountDisplayMode });
      await refresh();
      setCalendarColorsMessage('カレンダーの色を保存しました。');
    } catch (cause) {
      setCalendarColorsMessage(cause instanceof Error ? cause.message : '色を保存できませんでした。');
    } finally {
      setCalendarColorsSaving(false);
    }
  };

  const selectWeatherRegion = async (candidate: WeatherRegionCandidate) => {
    if (weatherUpdating) return;
    setWeatherCandidate(candidate);
    setWeatherUpdating(true);
    setWeatherMessage(null);
    try {
      await saveWeatherLocation(database, {
        region: weatherRegion.trim(),
        displayName: candidate.label,
        latitude: candidate.latitude,
        longitude: candidate.longitude,
      });
      await refresh({ waitForWeather: true });
      setWeatherRegion(weatherRegion.trim());
      setWeatherResultsDismissed(false);
      setWeatherMessage({ text: `天気を調べる地域を「${candidate.label}」に設定しました。`, kind: 'success' });
    } catch (cause) {
      setWeatherCandidate(null);
      setWeatherMessage({ text: cause instanceof Error ? cause.message : '地域を保存できませんでした。', kind: 'error' });
    } finally {
      setWeatherUpdating(false);
    }
  };

  const disableWeather = async () => {
    setWeatherUpdating(true);
    setWeatherMessage(null);
    try {
      await clearWeatherLocation(database);
      await refresh({ waitForWeather: true });
      setWeatherResultsDismissed(true);
      setWeatherCandidate(null);
      setWeatherMessage({ text: '天気連動を停止し、保存した地域を削除しました。', kind: 'success' });
    } catch (cause) {
      setWeatherMessage({ text: cause instanceof Error ? cause.message : '天気連動を停止できませんでした。', kind: 'error' });
    } finally {
      setWeatherUpdating(false);
    }
  };

  const toggleNotifications = async (enabled: boolean) => {
    setNotificationUpdating(true);
    setMessage(null);
    try {
      if (enabled && !(await notificationGateway.requestPermission())) {
        setMessage(Platform.OS === 'web'
          ? 'このブラウザでは通知を利用できません。'
          : '通知は有効になりませんでした。端末の設定から許可できます。');
        return;
      }
      await setNotificationsEnabled(database, enabled);
      await refresh();
      setMessage(enabled ? '通知を有効にしました。' : '通知をオフにしました。');
    } catch {
      setMessage('通知設定を変更できませんでした。');
    } finally {
      setNotificationUpdating(false);
    }
  };

  return (
    <Page>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹  戻る</Text></Pressable>
      <ScreenHeading eyebrow="SETTINGS" title="設定" description="家事の周期やアプリの使い方を調整できます。" />
      {loadError ? <Card><Text style={styles.error}>{loadError}</Text></Card> : null}

      <AccordionSection title="生活リズム" expanded={expandedSections.has('life-rhythm')} onToggle={() => toggleSection('life-rhythm')}>
        <Text style={styles.label}>家事の頻度</Text>
        <View style={styles.modeRow}>
          {modeOptions.map((option) => (
            <ChoiceChip key={option.id} label={`${option.label} · ${option.detail}`} selected={mode === option.id} onPress={() => setMode(option.id)} />
          ))}
        </View>
        <Text style={styles.label}>休日</Text>
        <View style={styles.weekdayRow}>
          {weekdays.map((day) => {
            const selected = restDays.includes(day.id);
            return (
              <Pressable
                key={day.id}
                accessibilityRole="button"
                accessibilityLabel={`${day.label}曜日`}
                accessibilityState={{ selected }}
                onPress={() => toggleRestDay(day.id)}
                style={({ pressed }) => [styles.weekdayChip, selected && styles.weekdayChipSelected, pressed && styles.weekdayChipPressed]}
              >
                <Text style={[styles.weekdayChipText, selected && styles.weekdayChipTextSelected]}>{day.label}</Text>
              </Pressable>
            );
          })}
        </View>
        <Text style={styles.hint}>休日を含む期間になるよう、家事ごとの許容範囲内で予定を調整します。</Text>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>重い家事の1日上限</Text><Text style={styles.hint}>初期値：1件</Text></View>
          <Counter value={heavyLimit} onChange={setHeavyLimit} maximum={10} label="重い家事の上限" />
        </View>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>普通の家事の1日上限</Text><Text style={styles.hint}>初期値：2件</Text></View>
          <Counter value={normalLimit} onChange={setNormalLimit} maximum={20} label="普通の家事の上限" />
        </View>
        {message ? <Text style={message.includes('保存し') || message.includes('追加しました') ? styles.success : styles.error}>{message}</Text> : null}
        <AppButton title={saving ? '保存中…' : '設定を保存'} onPress={() => void save()} disabled={saving} />
      </AccordionSection>

      <AccordionSection title="カレンダーの家事数表示" expanded={expandedSections.has('calendar-count')} onToggle={() => toggleSection('calendar-count')}>
        <Text style={styles.label}>表示方法</Text>
        <View style={styles.modeRow}>
          <ChoiceChip label="短い横棒" selected={calendarCountDisplayMode === 'bar'} onPress={() => setCalendarCountDisplayMode('bar')} />
          <ChoiceChip label="点" selected={calendarCountDisplayMode === 'dots'} onPress={() => setCalendarCountDisplayMode('dots')} />
        </View>
        <Text style={styles.hint}>{calendarCountDisplayMode === 'bar'
          ? '横棒は1本だけを色で表示し、数字は付けません。'
          : '1〜4件はその件数分、5〜9件は中間色の1〜5個、10〜14件は多件数色の1〜5個で表示します。15件以上は多件数色の5個で固定します。'}</Text>
        <Text style={styles.label}>件数帯ごとの色</Text>
        {([
          { key: 'low', title: '1〜4件' },
          { key: 'medium', title: '5〜9件' },
          { key: 'high', title: '10件以上' },
        ] as const).map(({ key, title }) => (
          <View key={key} style={styles.colorTier}>
            <Text style={styles.label}>{title}</Text>
            <View style={styles.colorOptionRow}>
              {CALENDAR_COUNT_COLOR_OPTIONS.map((option) => {
                const selected = calendarCountColors[key] === option.value;
                return (
                  <Pressable
                    key={option.value}
                    accessibilityRole="button"
                    accessibilityLabel={`${title}の色を${option.name}にする`}
                    accessibilityState={{ selected }}
                    onPress={() => setCalendarCountColors((current) => ({ ...current, [key]: option.value }))}
                    style={styles.colorOption}
                  >
                    <View style={[styles.colorSwatch, { backgroundColor: option.value }, selected && styles.colorSwatchSelected]}>
                      {selected ? <Text style={styles.colorCheck}>✓</Text> : null}
                    </View>
                    <Text style={[styles.colorOptionLabel, selected && styles.colorOptionLabelSelected]}>{option.name}</Text>
                  </Pressable>
                );
              })}
            </View>
          </View>
        ))}
        <View style={styles.calendarPreview}>
          <Text style={styles.label}>表示プレビュー</Text>
          <View style={styles.previewRow}>
            {[
              { count: 4, label: '1〜4件' },
              { count: 9, label: '5〜9件' },
              { count: 15, label: '10件以上' },
            ].map(({ count, label }) => (
              <View key={label} style={styles.previewCell}>
                <Text style={styles.previewDate}>24</Text>
                <CalendarTaskCountIndicator count={count} colors={calendarCountColors} mode={calendarCountDisplayMode} />
                <Text style={styles.previewCount}>{count}件</Text>
              </View>
            ))}
          </View>
        </View>
        {calendarColorsMessage ? <Text style={calendarColorsMessage.includes('保存しました') ? styles.success : styles.error}>{calendarColorsMessage}</Text> : null}
        <AppButton title={calendarColorsSaving ? '保存中…' : '表示設定を保存'} onPress={() => void saveCalendarColors()} disabled={calendarColorsSaving} />
      </AccordionSection>

      <AccordionSection title="家事ごとの設定" expanded={expandedSections.has('chore-settings')} onToggle={() => toggleSection('chore-settings')}>
        <Text style={styles.hint}>家事を選ぶと周期、実施期間、負荷を変更できます。</Text>
        {groupChoresByCategory(snapshot.chores.filter((chore) => !chore.archived)).map(([category, chores]) => {
          const expanded = expandedCategories.has(category);
          return (
            <View key={category} style={styles.choreGroup}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setExpandedCategories((current) => {
                  const next = new Set(current);
                  if (next.has(category)) next.delete(category);
                  else next.add(category);
                  return next;
                })}
                style={styles.choreGroupHeader}>
                <Text style={styles.choreGroupTitle}>{category}</Text>
                <Text style={styles.groupCount}>{chores.length}件　{expanded ? '−' : '＋'}</Text>
              </Pressable>
              {expanded ? chores.map((chore) => (
                <Pressable
                  key={chore.id}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/settings/chore/[id]', params: { id: chore.id } })}
                  style={styles.choreSettingRow}>
                  <View style={styles.choreSettingCopy}>
                    <Text style={styles.choreSettingTitle}>{chore.name}</Text>
                    <Text style={styles.hint}>{chore.enabled ? '有効' : '無効'} · 周期や負荷を調整</Text>
                  </View>
                  <Text style={styles.chevron}>›</Text>
                </Pressable>
              )) : null}
            </View>
          );
        })}
      </AccordionSection>

      <Card>
        <SectionHeading title="ゴミ収集日" />
        <Text style={styles.hint}>収集区分と曜日を入力すると、次の収集日を表示します。</Text>
        <AppButton title="ゴミの曜日を管理" onPress={() => router.push('/waste')} variant="secondary" />
      </Card>

      {Platform.OS !== 'web' ? (
        <AccordionSection title="通知・ウィジェット" expanded={expandedSections.has('notifications')} onToggle={() => toggleSection('notifications')}>
          <View style={styles.notificationRow}>
            <View style={styles.limitCopy}>
              <Text style={styles.featureTitle}>家事の通知を受け取る</Text>
              <Text style={styles.hint}>毎朝9時に、期間の開始日・最終日・終了翌日に未完了の家事をまとめて通知します。</Text>
            </View>
            <Switch value={snapshot.settings.notificationsEnabled} disabled={notificationUpdating} onValueChange={(value) => void toggleNotifications(value)} />
          </View>
          <View style={styles.divider} />
          <FeatureStatus title="今日の家事ウィジェット" status="iOS・Android" detail="最大3件を表示します。丸を押すと完了でき、完了した家事はチェック付きで残ります。" />
        </AccordionSection>
      ) : null}

      <Card>
        <SectionHeading title="天気予報・洗濯" />
        <FeatureStatus
          title="天気予報・洗濯予定"
          status={snapshot.settings.weatherLocation ? '地域指定中' : '未設定'}
          detail={snapshot.settings.weatherLocation
            ? `対象地域：${snapshot.settings.weatherLocation.displayName}。地域名と検索地点の座標は端末内に保存し、予報取得時にOpen-Meteoへ座標を送信します。`
            : '市区町村を入力して候補を確定すると、予報を使って今後7日以内の洗濯予定を調整します。端末の位置情報は使いません。'}
        />
        <TextInput
          value={weatherRegion}
          editable={!weatherUpdating}
          onChangeText={(value) => {
            setWeatherRegion(value);
            setWeatherSearchEnabled(true);
            setWeatherResultsDismissed(false);
            setWeatherCandidate(null);
            setWeatherMessage(null);
          }}
          placeholder="市区町村名を入力（例：横浜市）"
          placeholderTextColor={palette.muted}
          style={styles.regionInput}
          accessibilityLabel="天気予報に使う市区町村"
          returnKeyType="done"
        />
        <Text style={styles.hint}>入力すると候補を検索します。候補は「市区町村、都道府県」で表示します。</Text>
        {weatherSuggestions.status === 'searching' ? <ActivityIndicator color={palette.accent} /> : null}
        <View style={styles.weatherActions}>
          {snapshot.settings.weatherLocation ? (
            <AppButton title="連動を解除" onPress={() => void disableWeather()} disabled={weatherUpdating} variant="quiet" compact />
          ) : null}
        </View>
        {weatherSuggestions.candidates.length > 0 && !weatherResultsDismissed ? (
          <View style={styles.regionResults}>
            <Text style={styles.label}>候補を選択</Text>
            {weatherSuggestions.candidates.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityLabel={`地域 ${candidate.label} を選択`}
                accessibilityState={{ selected: weatherCandidate?.id === candidate.id }}
                disabled={weatherUpdating}
                onPress={() => void selectWeatherRegion(candidate)}
                style={({ pressed }) => [styles.regionCandidate, weatherCandidate?.id === candidate.id && styles.regionCandidateSelected, pressed && styles.regionCandidatePressed]}
              >
                <Text style={styles.regionCandidateText}>{candidate.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {weatherSuggestions.status === 'empty' && !weatherResultsDismissed
          ? <Text style={styles.hint}>市区町村が見つかりませんでした。市区町村名を変えてください。</Text>
          : null}
        {weatherSuggestions.status === 'error' && !weatherResultsDismissed
          ? <Text style={styles.error}>{weatherSuggestions.error}</Text>
          : null}
        {weatherSuggestions.status === 'debouncing' || weatherSuggestions.status === 'searching'
          ? <Text style={styles.hint}>市区町村を検索しています…</Text>
          : null}
        {weatherMessage ? (
          <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text>
        ) : null}
        <View style={styles.divider} />
        <FeatureStatus
          title="家電お手入れ AI"
          status={Platform.OS === 'web' ? 'Web版では停止' : '検索操作時のみ接続'}
          detail={Platform.OS === 'web'
            ? 'ブラウザ版からAI解析APIへは接続しません。AI向けの指示文は残してあり、登録済みの家電情報は確認できます。'
            : '家事一覧からメーカー・製品名・型番を入力して解析できます。APIキーはサーバー側だけで扱い、家電情報と確認済み結果は端末内に保存します。'}
        />
      </Card>

      <Text style={styles.footer}>家事データ、曜日、予定、履歴はローカルSQLiteに保存されます。</Text>
    </Page>
  );
}

function Counter({ value, onChange, maximum, label }: {
  value: number; onChange: (value: number) => void; maximum: number; label: string;
}) {
  return (
    <View style={styles.counter}>
      <Pressable onPress={() => onChange(Math.max(1, value - 1))} disabled={value <= 1}
        accessibilityRole="button" accessibilityLabel={`${label}を減らす`}>
        <Text style={[styles.counterButton, value <= 1 && { opacity: 0.35 }]}>−</Text>
      </Pressable>
      <Text style={styles.counterValue}>{value}</Text>
      <Pressable onPress={() => onChange(Math.min(maximum, value + 1))} disabled={value >= maximum}
        accessibilityRole="button" accessibilityLabel={`${label}を増やす`}>
        <Text style={[styles.counterButton, value >= maximum && { opacity: 0.35 }]}>＋</Text>
      </Pressable>
    </View>
  );
}

function FeatureStatus({ title, status, detail }: { title: string; status: string; detail: string }) {
  return (
    <View style={styles.feature}>
      <View style={styles.featureTop}><Text style={styles.featureTitle}>{title}</Text><Text style={styles.featureStatus}>{status}</Text></View>
      <Text style={styles.hint}>{detail}</Text>
    </View>
  );
}

function groupChoresByCategory(chores: readonly ChoreDefinition[]): [string, ChoreDefinition[]][] {
  const groups = new Map<string, ChoreDefinition[]>();
  for (const chore of chores) groups.set(chore.category, [...(groups.get(chore.category) ?? []), chore]);
  return [...groups.entries()];
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  accordionChevron: { color: palette.accent, fontSize: 23, fontWeight: '700', lineHeight: 28, transform: [{ rotate: '0deg' }] },
  accordionChevronExpanded: { transform: [{ rotate: '180deg' }] },
  label: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  weekdayRow: { width: '100%', flexDirection: 'row', flexWrap: 'nowrap', gap: 5 },
  weekdayChip: { flex: 1, minWidth: 0, minHeight: 40, borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 0 },
  weekdayChipSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  weekdayChipPressed: { opacity: 0.75 },
  weekdayChipText: { color: palette.muted, fontSize: 13, fontWeight: '600' },
  weekdayChipTextSelected: { color: palette.accent, fontWeight: '700' },
  hint: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  limitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  limitCopy: { flex: 1, gap: 3 },
  colorTier: { gap: 8, paddingVertical: 6, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  colorOptionRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 10 },
  colorOption: { width: 38, alignItems: 'center', gap: 3 },
  colorSwatch: { width: 28, height: 28, borderRadius: 14, borderWidth: 2, borderColor: '#FFFFFF', alignItems: 'center', justifyContent: 'center' },
  colorSwatchSelected: { borderColor: palette.ink },
  colorCheck: { color: '#FFFFFF', fontSize: 16, fontWeight: '900', lineHeight: 19, textShadowColor: '#333333', textShadowRadius: 2 },
  colorOptionLabel: { color: palette.muted, fontSize: 10 },
  colorOptionLabelSelected: { color: palette.ink, fontWeight: '700' },
  calendarPreview: { gap: 8, padding: 12, borderRadius: 14, borderWidth: 1, borderColor: palette.border, backgroundColor: '#FBFCFE' },
  previewRow: { flexDirection: 'row', justifyContent: 'space-around' },
  previewCell: { minWidth: 76, alignItems: 'center', gap: 2 },
  previewDate: { color: palette.ink, fontSize: 15, fontWeight: '700' },
  previewCount: { color: palette.muted, fontSize: 10 },
  counter: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: palette.background, borderRadius: 12, paddingHorizontal: 9, paddingVertical: 5 },
  counterButton: { color: palette.accent, fontSize: 20, fontWeight: '700', paddingHorizontal: 4 },
  counterValue: { minWidth: 18, color: palette.ink, textAlign: 'center', fontWeight: '700' },
  choreGroup: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  choreGroupHeader: { minHeight: 46, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  choreGroupTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  groupCount: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  choreSettingRow: { minHeight: 52, flexDirection: 'row', alignItems: 'center', gap: 10, paddingHorizontal: 9, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  choreSettingCopy: { flex: 1, gap: 2 },
  choreSettingTitle: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  chevron: { color: palette.accent, fontSize: 22 },
  regionInput: { minHeight: 44, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background },
  regionResults: { gap: 7 },
  regionCandidate: { minHeight: 42, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center', backgroundColor: palette.surface },
  regionCandidatePressed: { backgroundColor: palette.accentSoft },
  regionCandidateSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  regionCandidateText: { color: palette.ink, fontSize: 13, fontWeight: '600' },
  feature: { gap: 5, paddingVertical: 2 },
  notificationRow: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  weatherActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  featureTop: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8 },
  featureTitle: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  featureStatus: { color: palette.accent, fontSize: 10, fontWeight: '700', backgroundColor: palette.accentSoft, borderRadius: 8, overflow: 'hidden', paddingHorizontal: 8, paddingVertical: 4 },
  divider: { height: StyleSheet.hairlineWidth, backgroundColor: palette.border, marginVertical: 1 },
  footer: { color: palette.muted, fontSize: 11, textAlign: 'center' },
  error: { color: palette.warning, fontSize: 13 },
  success: { color: palette.accent, fontSize: 13, fontWeight: '600' },
});
