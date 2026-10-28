import { useCallback, useEffect, useRef, useState } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, Text } from 'react-native';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { PrivateCalendarSourceScreen } from '../../features/sharing/private-calendar/source-screen';
import { createPrivateCalendarSourcePreview } from '../../platform/sharing/private-calendar-source-preview';

export default function PrivateCalendarSourcePreviewRoute() {
  const params = useLocalSearchParams<{ host?: string; port?: string; attempt?: string }>();
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview key={JSON.stringify([params.host, params.port, params.attempt])} host={params.host} port={params.port} />;
}
function Preview({ host, port }: { host: unknown; port: unknown }) {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createPrivateCalendarSourcePreview> | null>(null); const alive = useRef(true);
  const [result, setResult] = useState<string | null>(null); const [busy, setBusy] = useState(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; void pending.current?.then(value => value.close()).catch(() => {}); }; }, []);
  const context = useCallback(async () => {
    if (!alive.current) throw new Error('検査画面を閉じています。');
    pending.current ??= createPrivateCalendarSourcePreview(Platform.OS, host, port);
    try { const value = await pending.current; if (!alive.current) throw new Error('検査画面を閉じています。'); return value; }
    catch (error) { pending.current = null; throw error; }
  }, [host, port]);
  const loadRuntime = useCallback(async () => (await context()).runtime, [context]);
  async function run(verify: boolean) {
    if (!alive.current || running.current) return; running.current = true; setBusy(true); setResult(null);
    try { const value = await context(); const next = verify ? await value.verify() : await value.initialize();
      if (alive.current) setResult(verify ? `本人日時判定 PASS：設定 ${next.revision}・合成取得 ${'queries' in next ? next.queries : 0}回` : '検査端末の準備完了・取得元の設定を再読込してください。');
    } catch { if (alive.current) setResult('検査は未完了です。保存済みの検査データを保持しています。'); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  }
  return <PrivateCalendarSourceScreen loadRuntime={loadRuntime} onBack={() => router.back()} onDevices={() => {}}
    footer={<Card><SectionHeading title="開発用・取得元の検査" /><Text style={typography.caption}>合成した時間帯だけを使用します。Google API・実アカウント・個人家事には接続しません。</Text>
      <AppButton title="検査専用の初回端末を準備" disabled={busy} onPress={() => run(false)} />
      <AppButton title="保存済みの本人日時判定を照合" disabled={busy} onPress={() => run(true)} />
      {result ? <Text testID="private-source-proof" style={typography.label}>{result}</Text> : null}
    </Card>} />;
}
