import { useCallback } from 'react';
import { useRouter } from 'expo-router';
import { Text } from 'react-native';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { PrivateCalendarSourceScreen } from '../../features/sharing/private-calendar/source-screen';
import { openPrivateCalendarRuntime } from '../../platform/sharing/private-calendar-runtime';

export default function PrivateCalendarSourceRoute() {
  const { ready, userId } = useWorkspace(); const router = useRouter();
  const loadRuntime = useCallback(async () => { if (!userId) throw new Error('本人用アカウントを確認してください。'); return openPrivateCalendarRuntime(userId); }, [userId]);
  if (!ready || !userId) return <Page><Card><Text style={typography.body}>共有用アカウントでログインして、本人用Calendarを設定できます。</Text><AppButton title="共有用アカウントへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <PrivateCalendarSourceScreen key={userId} loadRuntime={loadRuntime} onBack={() => router.canGoBack() ? router.back() : router.replace('/sharing/private-calendar')}
    onDevices={() => router.push('/sharing/private-calendar')} />;
}
