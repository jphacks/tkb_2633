import { useCallback, useEffect, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Platform, Text } from 'react-native';
import { Card, Page, typography } from '../../components/planner-ui';
import { PrivateCalendarDeviceScreen } from '../../features/sharing/private-calendar/device-screen';
import { createPrivateCalendarDevicePreview } from '../../platform/sharing/private-calendar-device-preview';

export default function PrivateCalendarDevicePreviewRoute() {
  const params = useLocalSearchParams<{ host?: string; port?: string; attempt?: string }>();
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview key={JSON.stringify([params.host, params.port, params.attempt])} host={params.host} port={params.port} />;
}
function Preview({ host, port }: { host: unknown; port: unknown }) {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createPrivateCalendarDevicePreview> | null>(null); const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; void pending.current?.then(value => value.close()).catch(() => {}); }; }, []);
  const loadSession = useCallback(async () => {
    if (!alive.current) throw new Error('検査画面を閉じています。');
    pending.current ??= createPrivateCalendarDevicePreview(Platform.OS, host, port);
    try { const value = await pending.current; if (!alive.current) throw new Error('検査画面を閉じています。'); return value.session; }
    catch (error) { pending.current = null; throw error; }
  }, [host, port]);
  return <PrivateCalendarDeviceScreen loadSession={loadSession} onBack={() => router.back()}
    onShare={async () => { throw new Error('合成検査の確認情報を外部へ送信しません。'); }} />;
}
