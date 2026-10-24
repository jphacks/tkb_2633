import { router } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { ChoreScheduleCard } from '@/components/chore-schedule-card';
import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import { FirstRunSetup } from '@/features/onboarding/first-run-setup';
import { addDays, formatJapaneseDate, localDateFromDate } from '@/domain/scheduling/local-date';
import { usePlannerData } from '@/hooks/use-planner-data';
import { completeChore } from '@/platform/storage/repository';

export default function HomeScreen() {
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [completingIds, setCompletingIds] = useState<Set<string>>(new Set());
  const today = localDateFromDate(new Date());

  if (loading || !snapshot) {
    return <Page><ScreenHeading eyebrow="HOUSEWORK, IN GOOD TIME" title="家事のお知らせ" description="端末内の予定を読み込んでいます。" /></Page>;
  }

  if (!snapshot.settings.setupCompleted) {
    return (
      <Page>
        <ScreenHeading eyebrow="HOUSEWORK, IN GOOD TIME" title="家事のお知らせ" description="家事の予定を、生活に合わせて整えましょう。" />
        {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
        <FirstRunSetup snapshot={snapshot} onComplete={refresh} />
      </Page>
    );
  }

  const choresById = new Map(snapshot.chores.map((chore) => [chore.id, chore]));
  const prioritized = [...snapshot.scheduleEntries].sort((left, right) =>
    urgency(left.status) - urgency(right.status) || left.suggestedDate.localeCompare(right.suggestedDate),
  );
  const weekEnd = addDays(today, 7);
  const thisWeekCount = snapshot.scheduleEntries.filter((entry) =>
    entry.status === 'overdue' || (entry.suggestedDate >= today && entry.suggestedDate <= weekEnd),
  ).length;
  const todayWaste = snapshot.upcomingWasteDates.filter((occurrence) => occurrence.date === today);

  const finish = async (entryId: string) => {
    const entry = snapshot.scheduleEntries.find((candidate) => candidate.id === entryId);
    if (!entry || completingIds.has(entryId)) return;
    setCompletingIds((current) => new Set(current).add(entryId));
    try {
      await completeChore(database, entry);
      await refresh();
    } finally {
      setCompletingIds((current) => {
        const next = new Set(current);
        next.delete(entryId);
        return next;
      });
    }
  };

  const openChore = (choreId: string) => {
    router.push({ pathname: '/chores/[id]', params: { id: choreId } });
  };

  return (
    <Page>
      <ScreenHeading eyebrow="HOUSEWORK, IN GOOD TIME" title="今日の家事" description={formatJapaneseDate(today, { weekday: true })} />

      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}

      <Card style={styles.summaryCard}>
        <View style={styles.summaryTop}>
          <View style={styles.summaryCopy}>
            <Text style={styles.summaryLabel}>今週の予定</Text>
            <Text style={styles.summaryValue}>{thisWeekCount}<Text style={styles.summaryUnit}>件</Text></Text>
          </View>
          <View style={styles.summaryMark}><Text style={styles.summaryMarkText}>⌂</Text></View>
        </View>
        <Text style={styles.summaryFoot}>実施期間の中で、できるタイミングに進めましょう。</Text>
      </Card>

      {snapshot.weatherOutcome === 'adjusted' ? (
        <Card style={styles.weatherNotice}>
          <Text style={styles.weatherTitle}>天気に合わせて洗濯予定を調整しました</Text>
          <Text style={styles.weatherBody}>{snapshot.weatherAdjustmentCount}件を、既存の実施期間と家事の制約内で見直しています。</Text>
        </Card>
      ) : null}
      {snapshot.weatherOutcome === 'unavailable' ? (
        <Card style={styles.weatherFallback}>
          <Text style={styles.weatherTitle}>天気予報を取得できませんでした</Text>
          <Text style={styles.weatherBody}>ルールで作成した通常の家事予定を表示しています。</Text>
        </Card>
      ) : null}

      {todayWaste.length > 0 ? (
        <Card style={styles.wasteNotice}>
          <View style={styles.wasteIcon}><Text style={styles.wasteIconText}>♻</Text></View>
          <View style={styles.wasteCopy}>
            <Text style={styles.wasteEyebrow}>今日のゴミ収集</Text>
            <Text style={styles.wasteNames}>{todayWaste.map((item) => item.label).join('・')}</Text>
          </View>
          <AppButton title="曜日" onPress={() => router.push('/waste')} variant="secondary" compact />
        </Card>
      ) : null}

      <SectionHeading title="次の家事" trailing={<Text style={styles.smallCount}>{prioritized.length}件の予定</Text>} />
      {prioritized.length === 0 ? (
        <Card>
          <Text style={styles.emptyTitle}>予定はまだありません</Text>
          <Text style={styles.emptyBody}>家事一覧から家事を有効にすると、予定が作られます。</Text>
          <AppButton title="家事一覧を見る" onPress={() => router.push('/chores')} variant="secondary" />
        </Card>
      ) : prioritized.slice(0, 5).map((entry) => {
        const chore = choresById.get(entry.choreId);
        if (!chore) return null;
        return (
          <ChoreScheduleCard
            key={entry.id}
            entry={entry}
            chore={chore}
            members={snapshot.members}
            onOpen={() => openChore(chore.id)}
            onComplete={() => void finish(entry.id)}
          />
        );
      })}

      <SectionHeading title="すぐ開く" />
      <View style={styles.quickActions}>
        <AppButton title="家事を探す" onPress={() => router.push('/chores')} variant="secondary" compact />
        <AppButton title="月間カレンダー" onPress={() => router.push('/explore')} variant="secondary" compact />
        <AppButton title="ゴミ曜日" onPress={() => router.push('/waste')} variant="secondary" compact />
      </View>
      <Text style={styles.localNote}>家事データと予定はこの端末に保存され、オフラインで使えます。</Text>
    </Page>
  );
}

function urgency(status: string): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}

const styles = StyleSheet.create({
  summaryCard: { backgroundColor: palette.accent, borderColor: palette.accent, padding: 21, gap: 12 },
  summaryTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  summaryCopy: { gap: 2 },
  summaryLabel: { color: '#DCE9DF', fontSize: 13, fontWeight: '600' },
  summaryValue: { color: '#FFFFFF', fontSize: 34, fontWeight: '800' },
  summaryUnit: { fontSize: 15, fontWeight: '600' },
  summaryFoot: { color: '#E8F0EA', fontSize: 12, lineHeight: 18 },
  weatherNotice: { backgroundColor: '#EEF5F0', borderColor: '#D9E6DC', gap: 4 },
  weatherFallback: { backgroundColor: '#FFF8EC', borderColor: '#F0E3CB', gap: 4 },
  weatherTitle: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  weatherBody: { color: palette.muted, fontSize: 12, lineHeight: 18 },
  summaryMark: { width: 56, height: 56, borderRadius: 18, backgroundColor: '#609078', alignItems: 'center', justifyContent: 'center' },
  summaryMarkText: { color: '#FFFFFF', fontSize: 28, fontWeight: '700' },
  wasteNotice: { flexDirection: 'row', alignItems: 'center', padding: 13, gap: 11, backgroundColor: '#F3F6E9', borderColor: '#E4E8D5' },
  wasteIcon: { width: 38, height: 38, borderRadius: 13, backgroundColor: '#E4EBCF', alignItems: 'center', justifyContent: 'center' },
  wasteIconText: { color: '#718449', fontSize: 19 },
  wasteCopy: { flex: 1, gap: 3 },
  wasteEyebrow: { color: '#718449', fontSize: 11, fontWeight: '700' },
  wasteNames: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  smallCount: { color: palette.muted, fontSize: 12 },
  emptyTitle: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  emptyBody: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  quickActions: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  localNote: { color: palette.muted, fontSize: 11, textAlign: 'center', marginTop: 2 },
  error: { color: palette.warning, fontSize: 13 },
});
