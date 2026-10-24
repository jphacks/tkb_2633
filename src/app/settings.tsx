import { router } from 'expo-router';
import { useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { Pressable, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { AppButton, Card, ChoiceChip, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { FrequencyMode } from '@/domain/chores/types';
import type { Weekday } from '@/domain/shared/types';
import { usePlannerData } from '@/hooks/use-planner-data';
import { OpenMeteoGeocodingProvider } from '@/features/weather/open-meteo-geocoder';
import type { WeatherRegionCandidate } from '@/features/weather/open-meteo-geocoder';
import {
  addHouseholdMember,
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
const weatherGeocoder = new OpenMeteoGeocodingProvider();
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
  const [memberName, setMemberName] = useState('');
  const [saving, setSaving] = useState(false);
  const [weatherUpdating, setWeatherUpdating] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [weatherRegion, setWeatherRegion] = useState(snapshot.settings.weatherLocation?.region ?? '');
  const [weatherCandidates, setWeatherCandidates] = useState<WeatherRegionCandidate[]>([]);
  const [weatherMessage, setWeatherMessage] = useState<{ text: string; kind: 'success' | 'error' } | null>(null);
  const [notificationUpdating, setNotificationUpdating] = useState(false);

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

  const addMember = async () => {
    try {
      await addHouseholdMember(database, memberName);
      setMemberName('');
      await refresh();
      setMessage('同居人を追加しました。家事詳細から担当を割り当てられます。');
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '追加できませんでした');
    }
  };

  const searchWeatherRegion = async () => {
    const region = weatherRegion.trim();
    if (region.length < 2) {
      setWeatherMessage({ text: '地域名を2文字以上で入力してください。', kind: 'error' });
      return;
    }
    setWeatherUpdating(true);
    setWeatherMessage(null);
    setWeatherCandidates([]);
    try {
      const candidates = await weatherGeocoder.search(region);
      setWeatherCandidates(candidates);
      setWeatherMessage(candidates.length > 0
        ? { text: '候補から天気を調べたい地域を選んでください。', kind: 'success' }
        : { text: '地域が見つかりませんでした。市区町村名などで再検索してください。', kind: 'error' });
    } catch (cause) {
      setWeatherMessage({
        text: cause instanceof Error ? cause.message : '地域を検索できませんでした。通信状態を確認して再試行してください。',
        kind: 'error',
      });
    } finally {
      setWeatherUpdating(false);
    }
  };

  const selectWeatherRegion = async (candidate: WeatherRegionCandidate) => {
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
      setWeatherCandidates([]);
      setWeatherMessage({ text: `天気を調べる地域を「${candidate.label}」に設定しました。`, kind: 'success' });
    } catch (cause) {
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
      setWeatherCandidates([]);
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
      <ScreenHeading eyebrow="SETTINGS" title="設定" description="生活リズム、担当、アプリの連携枠を管理します。" />
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
        <SectionHeading title="家族・同居人" />
        <Text style={styles.hint}>この端末内で家事の担当を分けられます。別端末との共有・同期は接続先を決めてから追加します。</Text>
        <View style={styles.memberList}>
          {snapshot.members.map((member) => (
            <View key={member.id} style={styles.memberRow}>
              <View style={styles.avatar}><Text style={styles.avatarText}>{member.displayName.slice(0, 1)}</Text></View>
              <Text style={styles.memberName}>{member.displayName}</Text>
              <Text style={styles.memberRole}>{member.id === 'local-member' ? 'あなた' : '同居人'}</Text>
            </View>
          ))}
        </View>
        <View style={styles.addMemberRow}>
          <TextInput value={memberName} onChangeText={setMemberName} placeholder="名前を入力" placeholderTextColor={palette.muted} style={styles.memberInput} accessibilityLabel="同居人の名前" returnKeyType="done" />
          <AppButton title="追加" onPress={() => void addMember()} variant="secondary" compact />
        </View>
        <AppButton title="家事の担当を割り当てる" onPress={() => router.push('/chores')} variant="quiet" compact />
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
        <SectionHeading title="外部機能の接続口" />
        <FeatureStatus
          title="天気予報・洗濯予定"
          status={snapshot.settings.weatherLocation ? '地域指定中' : '未設定'}
          detail={snapshot.settings.weatherLocation
            ? `対象地域：${snapshot.settings.weatherLocation.displayName}。地域名と検索地点の座標は端末内に保存し、予報取得時にOpen-Meteoへ座標を送信します。`
            : '地域名を入力して候補を選ぶと、Open-Meteoの予報で今後7日以内の洗濯予定を調整します。端末の位置情報は使いません。'}
        />
        <TextInput
          value={weatherRegion}
          editable={!weatherUpdating}
          onChangeText={(value) => {
            setWeatherRegion(value);
            setWeatherCandidates([]);
            setWeatherMessage(null);
          }}
          placeholder="例：横浜市、札幌市"
          placeholderTextColor={palette.muted}
          style={styles.regionInput}
          accessibilityLabel="天気を調べる地域"
          returnKeyType="search"
          onSubmitEditing={() => void searchWeatherRegion()}
        />
        <Text style={styles.hint}>入力した地域名はOpen-Meteoの地域検索に送信されます。端末の位置情報は利用しません。</Text>
        <View style={styles.weatherActions}>
          <AppButton
            title={weatherUpdating ? '検索・設定中…' : '地域を検索'}
            onPress={() => void searchWeatherRegion()}
            disabled={weatherUpdating || weatherRegion.trim().length < 2}
            variant="secondary"
            compact
          />
          {snapshot.settings.weatherLocation ? (
            <AppButton title="連動を解除" onPress={() => void disableWeather()} disabled={weatherUpdating} variant="quiet" compact />
          ) : null}
        </View>
        {weatherCandidates.length > 0 ? (
          <View style={styles.regionResults}>
            <Text style={styles.label}>候補を選択</Text>
            {weatherCandidates.map((candidate) => (
              <Pressable
                key={candidate.id}
                accessibilityRole="button"
                accessibilityLabel={`地域 ${candidate.label} を選択`}
                disabled={weatherUpdating}
                onPress={() => void selectWeatherRegion(candidate)}
                style={({ pressed }) => [styles.regionCandidate, pressed && styles.regionCandidatePressed]}
              >
                <Text style={styles.regionCandidateText}>{candidate.label}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {weatherMessage ? (
          <Text style={weatherMessage.kind === 'success' ? styles.success : styles.error}>{weatherMessage.text}</Text>
        ) : null}
        <View style={styles.divider} />
        <FeatureStatus title="家電お手入れ AI" status="検索操作時のみ接続" detail="家事一覧からメーカー・製品名・型番を入力して解析できます。APIキーはサーバー側だけで扱い、家電情報と確認済み結果は端末内に保存します。" />
        <View style={styles.divider} />
        <FeatureStatus title="家族間同期" status="未接続" detail="家事・担当・履歴は端末内に保存されます。同期先やアカウント方式は選定していません。" />
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
  memberList: { gap: 7 },
  memberRow: { flexDirection: 'row', alignItems: 'center', gap: 10, paddingVertical: 4 },
  avatar: { width: 32, height: 32, borderRadius: 11, alignItems: 'center', justifyContent: 'center', backgroundColor: palette.accentSoft },
  avatarText: { color: palette.accent, fontSize: 14, fontWeight: '700' },
  memberName: { flex: 1, color: palette.ink, fontSize: 14, fontWeight: '600' },
  memberRole: { color: palette.muted, fontSize: 11 },
  addMemberRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  memberInput: { flex: 1, minHeight: 42, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background },
  regionInput: { minHeight: 44, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background },
  regionResults: { gap: 7 },
  regionCandidate: { minHeight: 42, borderWidth: 1, borderColor: palette.border, borderRadius: 12, paddingHorizontal: 12, paddingVertical: 9, justifyContent: 'center', backgroundColor: palette.surface },
  regionCandidatePressed: { backgroundColor: palette.accentSoft },
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
