import { router } from 'expo-router';
import { useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { ActivityIndicator, Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import type { Weekday } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';
import { useMunicipalitySuggestions } from '@/features/weather/use-municipality-suggestions';
import {
  clearWeatherLocation,
  saveWeatherLocation,
  setNotificationsEnabled,
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
  if (loading || !snapshot) return <Page><ScreenHeading eyebrow="SETTINGS" title="設定" description="設定を読み込んでいます。" /></Page>;
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
  const [expandedCategories, setExpandedCategories] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
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
        setMessage('通知は有効になりませんでした。端末の設定から許可できます。');
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

      <Card>
        <SectionHeading title="生活リズム" />
        <Text style={styles.label}>家事の頻度</Text>
        <View style={styles.modeRow}>
          {modeOptions.map((option) => (
            <ChoiceChip key={option.id} label={`${option.label} · ${option.detail}`} selected={mode === option.id} onPress={() => setMode(option.id)} />
          ))}
        </View>
        <Text style={styles.label}>休日</Text>
        <View style={styles.modeRow}>{weekdays.map((day) => <ChoiceChip key={day.id} label={day.label} selected={restDays.includes(day.id)} onPress={() => toggleRestDay(day.id)} />)}</View>
        <Text style={styles.hint}>休日を含む期間になるよう、家事ごとの許容範囲内で予定を調整します。</Text>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>重い家事の1日上限</Text><Text style={styles.hint}>初期値：1件</Text></View>
          <Counter value={heavyLimit} onChange={setHeavyLimit} />
        </View>
        <View style={styles.limitRow}>
          <View style={styles.limitCopy}><Text style={styles.label}>普通の家事の1日上限</Text><Text style={styles.hint}>初期値：2件</Text></View>
          <Counter value={normalLimit} onChange={setNormalLimit} />
        </View>
        {message ? <Text style={message.includes('保存し') || message.includes('追加しました') ? styles.success : styles.error}>{message}</Text> : null}
        <AppButton title={saving ? '保存中…' : '設定を保存'} onPress={() => void save()} disabled={saving} />
      </Card>

      <Card>
        <SectionHeading title="家事ごとの設定" />
        <Text style={styles.hint}>家事を選ぶと周期、実施期間、負荷を変更できます。</Text>
        {groupChoresByCategory(snapshot.chores).map(([category, chores]) => {
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
      </Card>

      <Card>
        <SectionHeading title="ゴミ収集日" />
        <Text style={styles.hint}>収集区分と曜日を入力すると、次の収集日を表示します。</Text>
        <AppButton title="ゴミの曜日を管理" onPress={() => router.push('/waste')} variant="secondary" />
      </Card>

      <Card>
        <SectionHeading title="通知・ウィジェット" />
        <View style={styles.notificationRow}>
          <View style={styles.limitCopy}>
            <Text style={styles.featureTitle}>家事の通知を受け取る</Text>
            <Text style={styles.hint}>通知をオンにした操作で端末の許可を確認します。具体的な通知時刻や再通知は未設定です。</Text>
          </View>
          <Switch value={snapshot.settings.notificationsEnabled} disabled={notificationUpdating} onValueChange={(value) => void toggleNotifications(value)} />
        </View>
        <View style={styles.divider} />
        <FeatureStatus title="次の家事ウィジェット" status="iOS・Android" detail="iOSは2×2と中サイズ、Androidは2×2です。Schedulerの今日の優先順から最大3件を表示します。" />
      </Card>

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
        <FeatureStatus title="家電お手入れ AI" status="検索操作時のみ接続" detail="家事一覧からメーカー・製品名・型番を入力して解析できます。APIキーはサーバー側だけで扱い、家電情報と確認済み結果は端末内に保存します。" />
      </Card>

      <Text style={styles.footer}>家事データ、曜日、予定、履歴はローカルSQLiteに保存されます。</Text>
    </Page>
  );
}

function Counter({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  return (
    <View style={styles.counter}>
      <Text onPress={() => onChange(Math.max(1, value - 1))} accessibilityRole="button" style={styles.counterButton}>−</Text>
      <Text style={styles.counterValue}>{value}</Text>
      <Text onPress={() => onChange(value + 1)} accessibilityRole="button" style={styles.counterButton}>＋</Text>
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
  label: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  modeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: 7 },
  hint: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  limitRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingTop: 8, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  limitCopy: { flex: 1, gap: 3 },
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
