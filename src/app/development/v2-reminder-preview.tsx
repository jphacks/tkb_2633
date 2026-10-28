import { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { V2ReminderScreen } from '../../features/sharing/v2-ui/reminder-screen';
import { createV2ReminderPreview } from '../../platform/sharing/v2-reminder-preview';

export default function V2ReminderPreviewRoute() {
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview />;
}
function Preview() {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createV2ReminderPreview> | null>(null); const generation = useRef(0); const live = useRef(true);
  const [proof, setProof] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => { const epoch = generation; live.current = true; return () => { live.current = false; epoch.current++; const old = pending.current; pending.current = null; void old?.then(value => value.close()).catch(() => {}); }; }, []);
  const context = useCallback(async () => {
    if (!live.current) throw new Error('検査画面を閉じています。'); pending.current ??= createV2ReminderPreview(); const current = pending.current; const version = generation.current;
    try { const value = await current; if (!live.current || generation.current !== version || pending.current !== current) throw new Error('検査画面を再読込しています。'); return value; }
    catch (error) { if (pending.current === current) pending.current = null; throw error; }
  }, []);
  const load = useCallback(async () => (await context()).runtime, [context]);
  async function run(step: 'inspect' | 'complete' | 'undo' | 'verifySaved' | 'clean') {
    if (busy) return; setBusy(true); setProof(null);
    try { const value = await context(); const result = await value[step](); if (live.current) { setProof(result); if (step === 'clean') setAttempt(value => value + 1); } }
    catch { if (live.current) setProof('通知検査は未完了です。検査設定と通知を確認してください。'); }
    finally { if (live.current) setBusy(false); }
  }
  return <V2ReminderScreen key={attempt} load={load} onBack={() => router.back()} notice={<Card><SectionHeading title="開発用・共有通知検査" />
    <Text style={typography.caption}>独立した合成家事だけを使い、他の通知は保持します。下の設定を19時17分・ONにして検査します。</Text>
    {([['inspect', '通知予約を照合'], ['complete', '今回の検査家事を完了'], ['undo', '今回の検査家事の完了を取消'], ['verifySaved', '通知設定の保存値を照合'], ['clean', '検査通知を片付ける']] as const)
      .map(([step, title]) => <AppButton key={step} title={title} variant="secondary" compact disabled={busy} onPress={() => { void run(step); }} />)}
    {proof ? <Text testID="v2-reminder-proof" style={typography.body}>{proof}</Text> : null}</Card>} />;
}
