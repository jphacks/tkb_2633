import { useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { AppButton, Card, palette, ScreenHeading, typography } from '../../../components/planner-ui';
import { V2FormScrollView } from '../v2-ui/form-controls';
import { developmentPrivateCalendarSecrets } from '../../../platform/sharing/private-calendar-secrets';
import { nativePrivateCalendarCrypto } from '../../../platform/sharing/native-private-calendar-crypto';
import { auditPrivateCalendarStoredState } from './private-calendar-store-audit';
import type { PrivateCalendarStoredAuditResult } from './private-calendar-store-audit';

export function PrivateCalendarStoreAuditScreen() {
  const [busy, setBusy] = useState(false); const [result, setResult] = useState<PrivateCalendarStoredAuditResult | null>(null); const [failed, setFailed] = useState(false);
  const alive = useRef(false); const running = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const run = async () => {
    if (!__DEV__ || running.current) return; running.current = true; setBusy(true); setResult(null); setFailed(false);
    try {
      const value = await auditPrivateCalendarStoredState({ development: __DEV__, crypto: nativePrivateCalendarCrypto, store: developmentPrivateCalendarSecrets() });
      if (alive.current) setResult(value);
    } catch { if (alive.current) setFailed(true); }
    finally { running.current = false; if (alive.current) setBusy(false); }
  };
  return <SafeAreaView style={{ flex: 1, backgroundColor: palette.background }} edges={['top', 'bottom']}><V2FormScrollView contentContainerStyle={{ padding: 20, gap: 16 }}>
    <ScreenHeading eyebrow="開発用・本人保存検査" title="本人用の安全な保存を検査" />
    <Card><Text style={typography.body}>{__DEV__ ? '検査専用の鍵とDBを使用します。アプリの終了・再起動前後で照合し、実アカウントの情報は読み書きしません。' : '開発ビルドだけで使用できます。'}</Text>
      {__DEV__ ? <AppButton title={busy ? '本人保存を検査中' : '本人保存を検査する'} disabled={busy} onPress={() => { void run(); }} /> : null}</Card>
    {result ? <Card><Text accessibilityRole="header" style={typography.section}>本人保存の検査 PASS：{result.checks.length}件</Text>
      <Text style={typography.body}>{result.mode === 'created' ? '初回の検査用保存を作成' : '保存済みの検査用データを復元'}</Text>
      <Text testID="private-calendar-store-device" style={typography.caption}>端末ID：{result.deviceId}</Text>
      <Text testID="private-calendar-store-authority" style={typography.caption}>認証照合値：{result.authorityDigest}</Text>
      <Text testID="private-calendar-store-proof" style={typography.caption}>保存照合値：{result.storageProof}</Text>
      {result.checks.map((check) => <Text key={check} style={typography.caption}>{check}</Text>)}</Card> : null}
    {failed ? <Card><Text accessibilityRole="alert" style={typography.body}>保存の検査に失敗しました。自動再生成せず、保存先と実装を確認してください。</Text></Card> : null}
  </V2FormScrollView></SafeAreaView>;
}
