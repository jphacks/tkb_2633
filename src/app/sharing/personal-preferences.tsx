import { useCallback, useLayoutEffect, useRef } from 'react';
import { Text } from 'react-native';
import { useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../components/planner-ui';
import { useWorkspace } from '../../hooks/use-workspace';
import { usePlannerData } from '../../hooks/use-planner-data';
import { PrivatePreferenceScreen } from '../../features/sharing/private-planner/preference-screen';
import { nativePrivatePlannerPreferences } from '../../platform/sharing/private-calendar-secrets';
import { getDeviceTimeZone } from '../../features/google-sync/calendar-availability';
import type { Weekday } from '../../domain/shared/types';

export default function PersonalPreferencesRoute() {
  const { ready, userId } = useWorkspace(); const { snapshot } = usePlannerData(); const router = useRouter(); const latest = useRef(snapshot?.settings);
  useLayoutEffect(() => { latest.current = snapshot?.settings; }, [snapshot]);
  const load = useCallback(async () => {
    if (!userId) throw new Error('本人用アカウントを確認してください。'); const settings = latest.current;
    if (!settings) throw new Error('本人の予定設定を読み込んでいます。再読込してください。');
    return { store: nativePrivatePlannerPreferences(userId), defaults: { timeZone: getDeviceTimeZone(),
      restDays: settings.restDays as Weekday[], loadLimits: { heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit }, allowedBands: [] } };
  }, [userId]);
  if (!ready || !userId) return <Page><Card><Text style={typography.body}>共有用アカウントでログインして、本人の設定を開けます。</Text>
    <AppButton title="共有用アカウントへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  return <PrivatePreferenceScreen key={userId} load={load} onBack={() => router.canGoBack() ? router.back() : router.replace('/sharing')} />;
}
