import { useCallback, useState } from 'react';
import { Text } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppButton, Card, Page, SectionHeading, typography } from '../../components/planner-ui';
import { PrivatePreferenceScreen } from '../../features/sharing/private-planner/preference-screen';
import { developmentPrivateCalendarSecrets, developmentPrivatePlannerPreferences } from '../../platform/sharing/private-calendar-secrets';

const ownerUserId = 'development-calendar-preferences-20261029';
export default function PrivatePlannerPreferencesPreviewRoute() {
  const { attempt } = useLocalSearchParams<{ attempt?: string }>();
  if (!__DEV__) return <Page><Card><Text style={typography.body}>開発ビルド専用です。</Text></Card></Page>;
  return <Preview key={typeof attempt === 'string' ? attempt : 'current'} />;
}
function Preview() {
  const router = useRouter(); const [proof, setProof] = useState<string | null>(null);
  const load = useCallback(async () => ({ store: developmentPrivatePlannerPreferences(ownerUserId), defaults: {
    timeZone: 'Asia/Tokyo', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 }, allowedBands: [],
  } }), []);
  return <PrivatePreferenceScreen load={load} onBack={() => router.back()}
    notice={<Card><SectionHeading title="開発用・本人時間帯検査" /><Text style={typography.caption}>専用の合成UIDへ保存します。実アカウントや個人家事、クラウドへ接続しません。</Text></Card>}
    footer={<Card><AppButton title="保存した本人時間帯を照合" onPress={async () => {
      setProof(null);
      try {
        const value = await developmentPrivatePlannerPreferences(ownerUserId).read();
        if (!value) { setProof('本人時間帯検査は未完了です：未保存'); return; }
        const band = value?.allowedBands.find(row => row.weekday === 1 && row.startMinute === 1153 && row.endMinute === 1207);
        if (!band || value.timeZone !== 'Asia/Tokyo') { setProof('本人時間帯検査は未完了です：合成時刻の不一致'); return; }
        if (await developmentPrivateCalendarSecrets().publicState(ownerUserId)) throw new Error('Unexpected synthetic identity');
        setProof('本人時間帯検査 PASS：保護保存・時刻一致・鍵の自動作成なし');
      } catch { setProof('本人時間帯検査は未完了です。保存済みの検査設定を保持しています。'); }
    }} />{proof ? <Text testID="private-preferences-proof" style={typography.body}>{proof}</Text> : null}</Card>} />;
}
