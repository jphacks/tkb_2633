import { useCallback, useEffect, useRef, useState } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { V2GoogleTasksScreen } from '../../features/sharing/v2-ui/google-tasks-screen';
import { createV2GoogleTasksPreview } from '../../platform/sharing/v2-google-tasks-preview';

export default function V2GoogleTasksPreviewRoute() {
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview />;
}
function Preview() {
  const router = useRouter(); const pending = useRef<ReturnType<typeof createV2GoogleTasksPreview> | null>(null); const generation = useRef(0); const live = useRef(true);
  const [proof, setProof] = useState<string | null>(null); const [busy, setBusy] = useState(false); const [attempt, setAttempt] = useState(0);
  useEffect(() => { const epoch = generation; live.current = true; return () => { live.current = false; epoch.current++; const previous = pending.current; pending.current = null; void previous?.then(value => value.close()).catch(() => {}); }; }, []);
  const context = useCallback(async () => {
    if (!live.current) throw new Error('検査画面を閉じています。'); pending.current ??= createV2GoogleTasksPreview(); const current = pending.current; const version = generation.current;
    try { const value = await current; if (!live.current || generation.current !== version || pending.current !== current) throw new Error('検査画面を再読込しています。'); return value; }
    catch (error) { if (pending.current === current) pending.current = null; throw error; }
  }, []);
  const load = useCallback(async () => (await context()).runtime, [context]);
  async function run(step: 'verify' | 'localComplete' | 'localUndo' | 'remoteComplete' | 'remoteUndo' | 'changeDate' | 'verifySaved' | 'clean') {
    if (busy) return; setBusy(true); setProof(null);
    try { const result = await (await context())[step](); if (live.current) { setProof(result); if (step === 'clean') setAttempt(value => value + 1); } }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error && /^qa\/[a-z-]+$/u.test(String(error.code)) ? String(error.code) : 'qa/unconfirmed';
      if (live.current) setProof(`Google Tasks検査は未完了です（${code}）。`);
    } finally { if (live.current) setBusy(false); }
  }
  return <V2GoogleTasksScreen key={attempt} load={load} onBack={() => router.back()} notice={<Card><SectionHeading title="開発用・v2 Google Tasks検査" />
    <Text style={typography.caption}>独立した合成家事3件だけを、確認した実Googleアカウントの専用リストで検査します。Firebase・個人家事は使いません。下の連携を先に設定してください。</Text>
    {([['verify', 'Tasksの対応を照合'], ['localComplete', '合成家事をアプリで完了'], ['localUndo', '合成家事をアプリで取消'], ['remoteComplete', '合成Googleタスクを完了'], ['remoteUndo', '合成Googleタスクを取消'],
      ['changeDate', '合成家事の期日を変更'], ['verifySaved', 'Tasksの保存値を照合'], ['clean', '合成Googleタスクを片付ける']] as const).map(([step, title]) =>
      <AppButton key={step} title={title} variant="secondary" compact disabled={busy} onPress={() => { void run(step); }} />)}
    {proof ? <Text testID="v2-tasks-proof" style={typography.body}>{proof}</Text> : null}</Card>} />;
}
