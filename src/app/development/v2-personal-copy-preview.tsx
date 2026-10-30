import { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { V2PersonalCopyScreen } from '../../features/sharing/v2-ui/personal-copy-screen';
import { createV2PersonalCopyPreview } from '../../platform/sharing/v2-personal-copy-preview';

export default function V2PersonalCopyPreviewRoute() {
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview />;
}
function Preview() {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createV2PersonalCopyPreview> | null>(null); const live = useRef(true); const working = useRef(false);
  const [proof, setProof] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  useEffect(() => { live.current = true; return () => { live.current = false; const old = pending.current; pending.current = null; void old?.then(value => value.close()).catch(() => {}); }; }, []);
  const context = useCallback(async () => {
    if (!live.current) throw new Error('検査画面を閉じています。'); pending.current ??= createV2PersonalCopyPreview(); const attempt = pending.current;
    try { const value = await attempt; if (!live.current || pending.current !== attempt) throw new Error('検査画面を再読込しています。'); return value; }
    catch (error) { if (pending.current === attempt) pending.current = null; throw error; }
  }, []);
  const load = useCallback(async () => (await context()).runtime, [context]);
  return <V2PersonalCopyScreen load={load} onBack={() => router.back()} notice={<Card><SectionHeading title="開発用・個人設定コピー検査" />
    <Text style={typography.caption}>元の設定は合成2件です。実際の個人DB・Firebase・Googleは使いません。確認中と追加後、再起動後に保存を照合します。</Text>
    <AppButton title="コピーの保存値を照合" variant="secondary" disabled={busy} onPress={() => {
      if (working.current) return; working.current = true; setBusy(true); setProof(null);
      void context().then(value => value.inspect()).then(value => { if (live.current) setProof(value); })
        .catch(() => { if (live.current) setProof('コピー検査は未完了です。選択と保存状態を確認してください。'); })
        .finally(() => { working.current = false; if (live.current) setBusy(false); });
    }} />{proof ? <Text testID="v2-copy-proof" style={typography.body}>{proof}</Text> : null}</Card>} />;
}
