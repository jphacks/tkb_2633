import { router, useLocalSearchParams } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import { usePlannerData } from '@/hooks/use-planner-data';
import { recordIncompleteChore } from '@/platform/storage/repository';

export default function ChoreGuideScreen() {
  const params = useLocalSearchParams<{ choreId?: string }>();
  const requestedId = Array.isArray(params.choreId) ? params.choreId[0] : params.choreId;
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [selection, setSelection] = useState<{ routeId?: string; choreId?: string }>({ routeId: requestedId });
  const [recordingIncomplete, setRecordingIncomplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const selectedChoreId = selection.routeId === requestedId
    ? selection.choreId ?? requestedId
    : requestedId;

  if (loading || !snapshot) {
    return <Page><ScreenHeading title="家事の説明" description="家事を読み込んでいます。" /></Page>;
  }

  const chores = snapshot.chores;
  const selectedChore = chores.find((chore) => chore.id === selectedChoreId) ?? chores[0];
  const currentEntry = selectedChore
    ? snapshot.scheduleEntries.filter((entry) => entry.choreId === selectedChore.id)
      .find((entry) => entry.status === 'overdue' || entry.status === 'inWindow' || entry.status === 'initialPending')
      ?? snapshot.scheduleEntries.find((entry) => entry.choreId === selectedChore.id)
    : undefined;
  const canRecordIncomplete = Boolean(currentEntry && currentEntry.windowStart <= localDateFromDate(new Date()));

  const recordIncomplete = async () => {
    if (!currentEntry || !canRecordIncomplete || recordingIncomplete) return;
    setRecordingIncomplete(true);
    setMessage(null);
    try {
      const recorded = await recordIncompleteChore(database, currentEntry);
      setMessage(recorded ? '未完了を記録し、予定を再調整しました。' : 'この予定はすでに完了として記録されています。');
      await refresh();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '未完了を記録できませんでした。');
    } finally {
      setRecordingIncomplete(false);
    }
  };

  return (
    <Page>
      <ScreenHeading title="家事の説明" description="ホームで選んだ家事の手順、必要な道具、注意事項を確認できます。" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
      {selectedChore ? <ChoreGuide chore={selectedChore} /> : (
        <Card><Text style={styles.body}>家事がまだ登録されていません。</Text></Card>
      )}
      {selectedChore ? (
        <AppButton
          title="この家事の実施履歴を見る"
          onPress={() => router.push({ pathname: '/history', params: { choreId: selectedChore.id } })}
          variant="secondary"
        />
      ) : null}
      {currentEntry ? (
        <View style={styles.recordActions}>
          <AppButton
            title={recordingIncomplete ? '記録中…' : '未完了を記録'}
            onPress={() => void recordIncomplete()}
            disabled={!canRecordIncomplete || recordingIncomplete}
            variant="quiet"
          />
          {!canRecordIncomplete ? <Text style={styles.body}>実施期間が始まると未完了を記録できます。</Text> : null}
          {message ? <Text style={styles.body}>{message}</Text> : null}
        </View>
      ) : null}

      {chores.length > 1 ? (
        <View style={styles.otherChores}>
          <SectionHeading title="ほかの家事" />
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chorePicker}>
            {chores.map((chore) => (
              <Pressable
                key={chore.id}
                accessibilityRole="button"
                accessibilityState={{ selected: selectedChore?.id === chore.id }}
                onPress={() => setSelection({ routeId: requestedId, choreId: chore.id })}
                style={[styles.choreOption, selectedChore?.id === chore.id && styles.choreOptionSelected]}>
                <Text style={[styles.choreOptionText, selectedChore?.id === chore.id && styles.choreOptionTextSelected]}>{chore.name}</Text>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      ) : null}
    </Page>
  );
}

function ChoreGuide({ chore }: { chore: ChoreDefinition }) {
  return (
    <>
      <ScreenHeading title={chore.name} />
      <Card>
        <SectionHeading title="家事の手順" />
        {chore.instructions.length > 0 ? chore.instructions.map((step, index) => (
          <View key={`${index}-${step}`} style={styles.stepRow}>
            <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        )) : <Text style={styles.body}>手順はまだ登録されていません。</Text>}
      </Card>
      <Card>
        <SectionHeading title="必要な道具" />
        {chore.tools.length > 0
          ? <View style={styles.toolList}>{chore.tools.map((tool) => <Text key={tool} style={styles.toolText}>・{tool}</Text>)}</View>
          : <Text style={styles.body}>道具は特にありません。</Text>}
      </Card>
      <Card style={styles.cautionCard}>
        <Text style={styles.cautionHeading}>注意事項</Text>
        {chore.cautions.length > 0
          ? chore.cautions.map((caution) => <Text key={caution} style={styles.cautionText}>・{caution}</Text>)
          : <Text style={styles.body}>注意事項はありません。</Text>}
      </Card>
    </>
  );
}

const styles = StyleSheet.create({
  otherChores: { gap: 8, paddingTop: 5 },
  recordActions: { gap: 4 },
  chorePicker: { gap: 8, paddingRight: 20 },
  choreOption: { minHeight: 39, justifyContent: 'center', borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: '#FFFFFF', paddingHorizontal: 14 },
  choreOptionSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  choreOptionText: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  choreOptionTextSelected: { color: palette.accent, fontWeight: '700' },
  stepRow: { flexDirection: 'row', alignItems: 'flex-start', gap: 11 },
  stepNumber: { width: 25, color: palette.accent, fontSize: 13, fontWeight: '800', paddingTop: 1 },
  stepText: { flex: 1, color: palette.ink, fontSize: 14, lineHeight: 21 },
  toolList: { gap: 7 },
  toolText: { color: palette.ink, fontSize: 14, lineHeight: 21 },
  cautionCard: { backgroundColor: '#FBF5EB', borderColor: '#F0E4CD' },
  cautionHeading: { color: '#8D682E', fontSize: 14, fontWeight: '700' },
  cautionText: { color: '#765A31', fontSize: 13, lineHeight: 20 },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
});
