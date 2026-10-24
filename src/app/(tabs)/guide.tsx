import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import { PlannerLoadState } from '@/components/planner-load-state';
import { usePlannerData } from '@/hooks/use-planner-data';
import { recordIncompleteChore } from '@/platform/storage/repository';

export default function ChoreGuideScreen() {
  const params = useLocalSearchParams<{ choreId?: string; returnTo?: 'home' | 'calendar' }>();
  const requestedId = Array.isArray(params.choreId) ? params.choreId[0] : params.choreId;
  const requestedReturnTo = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = requestedReturnTo === 'home' || requestedReturnTo === 'calendar' ? requestedReturnTo : undefined;
  const navigation = useNavigation('/(tabs)') as {
    addListener(event: 'tabPress', callback: () => void): () => void;
    setParams(params: { choreId?: string | undefined; returnTo?: 'home' | 'calendar' | undefined }): void;
  };
  const { snapshot, loading, error, refresh, database } = usePlannerData();
  const [searchText, setSearchText] = useState('');
  const [recordingIncomplete, setRecordingIncomplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => navigation.addListener('tabPress', () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined });
  }), [navigation]);
  const returnFromDetail = () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined });
    if (returnTo === 'home') router.navigate('/');
    else if (returnTo === 'calendar') router.navigate('/(tabs)/explore');
  };
  const selectChoreFromList = (choreId: string) => router.setParams({ choreId, returnTo: undefined });
  const selectedChoreId = requestedId;
  const chores = useMemo(() => snapshot?.chores ?? [], [snapshot]);
  const query = normalizeChoreSearchText(searchText.trim());
  const { matchingChores, otherChores } = useMemo(() => {
    if (!query) return { matchingChores: chores, otherChores: [] as ChoreDefinition[] };

    const ranked = chores.map((chore, index) => {
      const name = normalizeChoreSearchText(chore.name);
      const matchIndex = name.indexOf(query);
      return { chore, index, matchIndex };
    });
    const matching = ranked
      .filter((item) => item.matchIndex >= 0)
      .sort((left, right) => left.matchIndex - right.matchIndex || left.index - right.index)
      .map((item) => item.chore);
    const matchedIds = new Set(matching.map((chore) => chore.id));
    return {
      matchingChores: matching,
      otherChores: chores.filter((chore) => !matchedIds.has(chore.id)),
    };
  }, [chores, query]);

  if (loading || !snapshot) {
    return <PlannerLoadState title="家事の説明" message="家事を読み込んでいます。" error={error} retry={refresh} />;
  }

  const selectedChore = selectedChoreId ? chores.find((chore) => chore.id === selectedChoreId) : undefined;
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

  if (!selectedChoreId) {
    return (
      <Page>
        <ScreenHeading title="家事の説明" description="説明を見たい家事を選んでください。" />
        {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
        <TextInput
          accessibilityLabel="家事名を検索"
          autoCapitalize="none"
          clearButtonMode="while-editing"
          onChangeText={setSearchText}
          placeholder="家事名で検索"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          style={styles.searchInput}
          value={searchText}
        />
        {chores.length > 0 ? (
          <>
            {query ? <SectionHeading title="検索結果" trailing={<Text style={styles.resultCount}>{matchingChores.length}件</Text>} /> : null}
            {query && matchingChores.length === 0 ? <Card><Text style={styles.body}>見出しに一致する家事はありません。</Text></Card> : null}
            <View style={styles.choreList}>
              {matchingChores.map((chore) => (
                <ChoreListRow key={chore.id} chore={chore} onPress={() => selectChoreFromList(chore.id)} />
              ))}
            </View>
            {query && otherChores.length > 0 ? (
              <>
                <SectionHeading title="ほかの家事" />
                <View style={styles.choreList}>
                  {otherChores.map((chore) => (
                    <ChoreListRow key={chore.id} chore={chore} onPress={() => selectChoreFromList(chore.id)} />
                  ))}
                </View>
              </>
            ) : null}
          </>
        ) : <Card><Text style={styles.body}>家事がまだ登録されていません。</Text></Card>}
      </Page>
    );
  }

  return (
    <Page>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="前の画面に戻る"
        onPress={returnFromDetail}
        style={styles.backButton}>
        <Text style={styles.backArrow}>‹</Text>
        <Text style={styles.backText}>戻る</Text>
      </Pressable>
      <ScreenHeading title="家事の説明" description="手順、必要な道具、注意事項を確認できます。" />
      {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
      {selectedChore ? <ChoreGuide chore={selectedChore} /> : (
        <Card><Text style={styles.body}>選んだ家事が見つかりませんでした。</Text></Card>
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
                onPress={() => router.setParams({ choreId: chore.id })}
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

function normalizeChoreSearchText(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u30a1-\u30f6]/g, (character) =>
      String.fromCharCode(character.charCodeAt(0) - 0x60));
}

function ChoreListRow({ chore, onPress }: { chore: ChoreDefinition; onPress: () => void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${chore.name}、${chore.category}`}
      onPress={onPress}
      style={({ pressed }) => [styles.choreListRow, pressed && styles.choreListRowPressed]}>
      <View style={styles.choreListCopy}>
        <Text style={styles.choreListName}>{chore.name}</Text>
        <Text style={styles.choreListCategory}>{chore.category}</Text>
      </View>
      <Text style={styles.choreListChevron}>›</Text>
    </Pressable>
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
  backButton: { alignSelf: 'flex-start', minHeight: 48, flexDirection: 'row', alignItems: 'center', paddingRight: 14, gap: 3 },
  backArrow: { color: palette.accent, fontSize: 34, lineHeight: 40, fontWeight: '600' },
  backText: { color: palette.accent, fontSize: 17, fontWeight: '700' },
  choreList: { gap: 10 },
  searchInput: { minHeight: 52, borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: '#FFFFFF', color: palette.ink, fontSize: 16, paddingHorizontal: 16 },
  resultCount: { color: palette.muted, fontSize: 12, fontWeight: '600' },
  choreListRow: { minHeight: 68, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', borderWidth: 1, borderColor: palette.border, borderRadius: 16, backgroundColor: '#FFFFFF', paddingHorizontal: 16, paddingVertical: 12 },
  choreListRowPressed: { backgroundColor: palette.accentSoft },
  choreListCopy: { flex: 1, gap: 4 },
  choreListName: { color: palette.ink, fontSize: 16, fontWeight: '700' },
  choreListCategory: { color: palette.muted, fontSize: 12 },
  choreListChevron: { color: palette.accent, fontSize: 31, lineHeight: 36, fontWeight: '500', paddingLeft: 12 },
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
