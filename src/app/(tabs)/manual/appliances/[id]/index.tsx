import { router, useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useCallback, useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';
import { loadApplianceCareReviewContext } from '@/platform/storage/repository';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';

export default function ApplianceDetailScreen() {
  const params = useLocalSearchParams<{ id: string; returnTo?: string }>();
  const applianceId = Array.isArray(params.id) ? params.id[0] : params.id;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  const database = useSQLiteContext();
  const [context, setContext] = useState<ApplianceCareReviewContext | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      setContext(await loadApplianceCareReviewContext(database, applianceId));
    } finally {
      setLoading(false);
    }
  }, [applianceId, database]);

  useFocusEffect(useCallback(() => {
    void refresh();
  }, [refresh]));

  if (loading) return <Page><ScreenHeading eyebrow="APPLIANCE CARE" title="家電の詳細" description="保存した公式資料とお手入れ項目を読み込んでいます。" /></Page>;
  if (!context) return <Page><ScreenHeading eyebrow="APPLIANCE CARE" title="家電が見つかりません" /><AppButton title="一覧へ戻る" onPress={() => router.replace(returnTo ?? '/manual')} /></Page>;

  const { appliance, chores } = context;
  return (
    <Page>
      <View style={styles.detailHeader}>
        <Pressable accessibilityRole="button" accessibilityLabel="一覧へ戻る" onPress={() => returnTo ? router.replace(returnTo) : router.back()}><Text style={styles.back}>‹</Text></Pressable>
        <Text style={styles.modelTitle}>{appliance.modelNumber}</Text>
      </View>
      <ScreenHeading eyebrow={appliance.manufacturer} title="お手入れ方法" description={`${appliance.displayName}の公式資料から確認した内容です。`} />
      <Card style={styles.productCard}>
        <Text style={styles.productMeta}>メーカー {appliance.manufacturer} · 型番 {appliance.modelNumber}</Text>
        {appliance.category ? <Text style={styles.body}>カテゴリ：{appliance.category}</Text> : null}
        {appliance.officialProductUrl ? <OfficialLink manufacturer={appliance.manufacturer} title="公式製品情報を見る ↗" url={appliance.officialProductUrl} /> : null}
        <OfficialLink manufacturer={appliance.manufacturer} title="公式取扱説明書を見る ↗" url={appliance.officialManualUrl} />
        <Text style={styles.note}>最終解析：{appliance.analysis.analyzedAt}</Text>
        <AppButton title="この家電を再解析" onPress={() => router.push({ pathname: '/manual/appliance-care', params: { applianceId: appliance.id, returnTo: returnTo ?? '/manual' } })} variant="secondary" />
      </Card>

      <SectionHeading title="お手入れ項目" trailing={<Text style={styles.note}>{appliance.analysis.tasks.length}件</Text>} />
      {appliance.analysis.tasks.map((task, index) => {
        const chore = chores.find((item) => item.applianceTaskName === task.name);
        return <MaintenanceTaskCard key={`${index}-${task.name}`} task={task} chore={chore} manufacturer={appliance.manufacturer} index={index} />;
      })}
    </Page>
  );
}

function MaintenanceTaskCard({ task, chore, manufacturer, index }: {
  task: ApplianceCareReviewContext['appliance']['analysis']['tasks'][number];
  chore?: ChoreDefinition;
  manufacturer: string;
  index: number;
}) {
  const manufacturerDays = task.recommendedIntervalDays;
  const userDays = chore?.userIntervalDays ?? chore?.recommendedCycleDays;
  const noSchedule = manufacturerDays === undefined && userDays === undefined;
  return (
    <Card>
      <Text style={styles.taskIndex}>お手入れ {String(index + 1).padStart(2, '0')}</Text>
      <Text style={styles.taskTitle}>{task.name}</Text>
      {noSchedule ? (
        <View style={styles.noSchedule}>
          <Text style={styles.noScheduleTitle}>定期予定なし</Text>
          {task.recommendedConditions?.map((condition) => <Text key={condition} style={styles.body}>メーカー指定：「{condition}」</Text>)}
          <Text style={styles.body}>メーカーから具体的な周期が指定されていないため、カレンダー・自動予定・定期通知には登録されません。</Text>
        </View>
      ) : (
        <View style={styles.intervalBlock}>
          {manufacturerDays !== undefined ? <Text style={styles.body}>メーカー推奨：{manufacturerDays}日</Text> : <Text style={styles.body}>メーカー指定：具体的周期なし</Text>}
          {userDays !== undefined && userDays !== manufacturerDays ? <Text style={styles.body}>あなたの設定：{userDays}日</Text> : null}
          <Text style={styles.intervalActual}>予定周期：{userDays ?? manufacturerDays}日</Text>
          {chore ? <Text style={styles.note}>{chore.enabled ? '家事一覧・カレンダーに登録済み' : '予定はオフです。家事一覧から変更できます。'}</Text> : <Text style={styles.note}>解析項目は保存済みですが、家事予定には登録していません。</Text>}
        </View>
      )}
      {task.recommendedConditions?.length && !noSchedule ? task.recommendedConditions.map((condition) => <Text key={condition} style={styles.body}>メーカー指定条件：{condition}</Text>) : null}
      <SectionHeading title="手順" />
      {task.steps.map((step, stepIndex) => <Text key={`${stepIndex}-${step}`} style={styles.body}>{stepIndex + 1}. {step}</Text>)}
      <Text style={styles.body}>必要な道具：{task.tools.length ? task.tools.join('、') : '記載なし'}</Text>
      {task.safetyCautions.length > 0 ? (
        <View style={styles.cautionBox}>
          <Text style={styles.cautionTitle}>安全上の注意・禁止事項</Text>
          {task.safetyCautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </View>
      ) : null}
      {task.estimatedMinutes !== undefined ? <Text style={styles.note}>メーカー記載の所要時間：約{task.estimatedMinutes}分</Text> : null}
      {task.evidence.map((evidence, evidenceIndex) => (
        <OfficialLink key={`${evidence.url}-${evidenceIndex}`} manufacturer={manufacturer} title={`出典を見る${evidence.pageOrSection ? ` · ${evidence.pageOrSection}` : ''} ↗`} url={evidence.url} />
      ))}
    </Card>
  );
}

function OfficialLink({ manufacturer, title, url }: { manufacturer: string; title: string; url: string }) {
  const valid = isOfficialApplianceUrl(url, manufacturer);
  if (!valid) return <Text style={styles.invalidLink}>公式URLを検証できないため開けません</Text>;
  return <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => undefined)}><Text style={styles.link}>{title}</Text></Pressable>;
}

const styles = StyleSheet.create({
  detailHeader: { minHeight: 36, flexDirection: 'row', alignItems: 'center', gap: 12 },
  back: { color: palette.accent, fontSize: 32, lineHeight: 36, fontWeight: '400', paddingHorizontal: 3 },
  modelTitle: { color: palette.ink, fontSize: 20, fontWeight: '700' },
  productCard: { backgroundColor: palette.accentSoft, borderColor: '#D8E7DC' },
  productMeta: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  taskIndex: { color: palette.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  taskTitle: { color: palette.ink, fontSize: 17, fontWeight: '700' },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  note: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  intervalBlock: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.surface },
  intervalActual: { color: palette.accent, fontSize: 14, fontWeight: '800' },
  noSchedule: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: '#FFF8EC', borderWidth: 1, borderColor: '#F0E3CB' },
  noScheduleTitle: { color: '#8D682E', fontSize: 15, fontWeight: '800' },
  cautionBox: { gap: 4, padding: 12, borderRadius: 12, backgroundColor: palette.warningSoft },
  cautionTitle: { color: palette.warning, fontSize: 13, fontWeight: '800' },
  cautionText: { color: palette.warning, fontSize: 12, lineHeight: 19 },
  link: { color: palette.accent, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  invalidLink: { color: palette.muted, fontSize: 11 },
});
