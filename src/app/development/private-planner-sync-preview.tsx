import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform, Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { PrivatePreferenceScreen } from '../../features/sharing/private-planner/preference-screen';
import { createPrivatePlannerPreview } from '../../platform/sharing/private-planner-preview';
import { preferenceValues } from '../../features/sharing/private-planner/preference-sync-state';

const defaults = { timeZone: 'Asia/Tokyo', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [] };
export default function PrivatePlannerSyncPreviewRoute() {
  const params = useLocalSearchParams<{ host?: string; port?: string; attempt?: string; expected?: string }>();
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview key={JSON.stringify(params)} host={params.host} port={params.port} expected={params.expected} />;
}
function Preview({ host, port, expected }: { host: unknown; port: unknown; expected: unknown }) {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createPrivatePlannerPreview> | null>(null); const alive = useRef(true);
  const generation = useRef(0);
  const [proof, setProof] = useState<string | null>(null); const [attempt, setAttempt] = useState(0); const [busy, setBusy] = useState(false); const [offline, setOffline] = useState(false);
  useEffect(() => { const epoch = generation; alive.current = true; return () => {
    alive.current = false; epoch.current++; const previous = pending.current; pending.current = null;
    void previous?.then(value => value.close()).catch(() => {});
  }; }, []);
  const context = useCallback(async () => {
    if (!alive.current) throw new Error('検査画面を閉じています。'); pending.current ??= createPrivatePlannerPreview(Platform.OS, host, port);
    const current = pending.current; const version = generation.current;
    try {
      const value = await current;
      if (!alive.current || generation.current !== version || pending.current !== current) throw new Error('検査画面を再読込しています。'); return value;
    } catch (error) { if (pending.current === current) pending.current = null; throw error; }
  }, [host, port]);
  const load = useCallback(async () => { const value = await context(); return { store: value.store, defaults,
    sync: { engine: value.engine, synchronize: async () => { const result = await value.synchronize(); setOffline(false); return result; }, onConfigure: () => router.back() } }; }, [context, router]);
  const values = (version: number) => ({ ...defaults, restDays: [version as 1 | 2 | 3 | 4],
    allowedBands: [{ weekday: 1 as const, startMinute: 1140 + version, endMinute: 1200 + version }] });
  async function seed(version: number, send: boolean) {
    if (busy) return; setBusy(true); setProof(null);
    try {
      const value = await context(); if (!send) { await value.pauseTransport(); setOffline(true); }
      const before = await value.store.read(); await value.store.save(before?.revision ?? 0, values(version));
      if (send) { const result = await value.synchronize(); setOffline(false); if (!['sent', 'received'].includes(result.kind)) throw new Error('合成本人設定の送信が未確認です。'); }
      setAttempt(n => n + 1); setProof(`合成本人設定${version}：${send ? '送信済み' : '端末内だけに保存済み'}`);
    } catch { setProof('合成本人設定は未完了です。保存内容は保持しています。'); }
    finally { setBusy(false); }
  }
  return <PrivatePreferenceScreen key={attempt} load={load} onBack={() => router.back()}
    notice={<Card><SectionHeading title="開発用・本人設定同期検査" /><Text style={typography.caption}>既存の合成UIDと承認済みの2端末だけを使用します。実アカウント・Google・個人家事へ接続しません。</Text>
      {[1, 2].map(version => <AppButton key={version} title={`合成設定${version}を保存して送信`} variant="secondary" disabled={busy} onPress={() => { void seed(version, true); }} />)}
      {[3, 4].map(version => <AppButton key={version} title={`合成設定${version}を端末内だけ保存`} variant="quiet" disabled={busy} onPress={() => { void seed(version, false); }} />)}
      <AppButton title="現在の合成本人設定を照合" variant="secondary" disabled={busy} onPress={async () => {
        setProof(null); try {
          if (!['1', '2', '3', '4'].includes(String(expected))) throw new Error('検査する合成版を指定してください。');
          const value = await context(); const state = await value.engine.readStatus(); const want = values(Number(expected));
          if (state.kind !== 'synchronized' || !state.local || JSON.stringify(preferenceValues(state.local)) !== JSON.stringify(want)) throw new Error('合成値または同期位置が一致しません。');
          setProof(`本人設定同期検査 PASS：合成${expected}・保護保存・受付一致`);
        } catch { setProof('本人設定同期検査は未完了です。保存内容は保持しています。'); }
      }} />{proof ? <Text testID="private-planner-sync-proof" style={typography.body}>{proof}</Text> : null}
      {offline ? <Text style={typography.caption}>本人設定のSDK通信は停止しています。</Text> : null}</Card>} />;
}
