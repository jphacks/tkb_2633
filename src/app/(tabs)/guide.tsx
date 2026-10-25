import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ChoreDefinition } from '@/domain/chores/types';
import { localDateFromDate } from '@/domain/scheduling/local-date';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
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
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [isTriviaCollectionOpen, setIsTriviaCollectionOpen] = useState(false);
  const [selectedTriviaId, setSelectedTriviaId] = useState<string | null>(null);
  const [recordingIncomplete, setRecordingIncomplete] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => navigation.addListener('tabPress', () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined });
    setSelectedCategory(null);
    setIsTriviaCollectionOpen(false);
    setSelectedTriviaId(null);
    setSearchText('');
  }), [navigation]);
  const returnFromDetail = () => {
    navigation.setParams({ choreId: undefined, returnTo: undefined });
    if (returnTo === 'home') router.navigate('/');
    else if (returnTo === 'calendar') router.navigate('/(tabs)/explore');
  };
  const selectChoreFromList = (choreId: string) => router.setParams({ choreId, returnTo: undefined });
  const returnFromTrivia = () => {
    if (selectedTriviaId) setSelectedTriviaId(null);
    else {
      setIsTriviaCollectionOpen(false);
      setSearchText('');
    }
  };
  const selectedChoreId = requestedId;
  const chores = useMemo(() => snapshot?.chores.filter((chore) => !chore.archived) ?? [], [snapshot]);
  const categories = useMemo(() => [...new Set(chores.map((chore) => chore.category))], [chores]);
  const triviaItems = useMemo(() => chores.flatMap((chore) =>
    (chore.trivia ?? []).map((trivia, index) => ({ id: `${chore.id}:${trivia.id || index}`, chore, trivia })),
  ), [chores]);
  const query = normalizeChoreSearchText(searchText.trim());
  const { matchingChores, otherChores } = useMemo(() => {
    const visibleChores = selectedCategory
      ? chores.filter((chore) => chore.category === selectedCategory)
      : chores;
    if (!query) return { matchingChores: visibleChores, otherChores: [] as ChoreDefinition[] };

    const ranked = visibleChores.map((chore, index) => {
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
      otherChores: visibleChores.filter((chore) => !matchedIds.has(chore.id)),
    };
  }, [chores, query, selectedCategory]);

  if (loading || !snapshot) {
    return <PlannerLoadState title="家事の説明" message="家事を読み込んでいます。" error={error} retry={refresh} />;
  }

  const selectedChore = selectedChoreId ? chores.find((chore) => chore.id === selectedChoreId) : undefined;
  const selectedTrivia = selectedTriviaId ? triviaItems.find((item) => item.id === selectedTriviaId) : undefined;
  const matchingTriviaItems = query
    ? triviaItems.filter((item) => normalizeChoreSearchText(item.trivia.title).includes(query))
    : triviaItems;
  const today = localDateFromDate(new Date());
  const todayTask = selectedChore
    ? selectDateTasks(snapshot.scheduleEntries, snapshot.completions, today, 3).find((task) => task.choreId === selectedChore.id)
    : undefined;
  const currentEntry = todayTask ? todayTask.entry
    : snapshot.scheduleEntries.find((entry) => entry.choreId === selectedChore?.id && entry.suggestedDate >= today);
  const canRecordIncomplete = Boolean(currentEntry && currentEntry.windowStart <= localDateFromDate(new Date()));

  if (selectedTriviaId) {
    return (
      <Page>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="豆知識一覧に戻る"
          onPress={returnFromTrivia}
          style={styles.backButton}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backText}>豆知識一覧へ戻る</Text>
        </Pressable>
        {selectedTrivia ? (
          <>
            <ScreenHeading title={selectedTrivia.trivia.title} description={selectedTrivia.chore.name} />
            <Card style={styles.triviaCard}>
              <Text style={styles.triviaHeading}>豆知識</Text>
              <Text style={styles.triviaBody}>{selectedTrivia.trivia.body}</Text>
            </Card>
          </>
        ) : <Card><Text style={styles.body}>この豆知識は見つかりませんでした。</Text></Card>}
      </Page>
    );
  }

  if (isTriviaCollectionOpen && !selectedChoreId) {
    return (
      <Page>
        <ScreenHeading title="豆知識" description="家事の見出しを選ぶと、知っていると便利な情報を確認できます。" />
        <TextInput
          accessibilityLabel="豆知識の見出しを検索"
          autoCapitalize="none"
          clearButtonMode="while-editing"
          onChangeText={setSearchText}
          placeholder="豆知識の見出しで検索"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          style={styles.searchInput}
          value={searchText}
        />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="家事一覧に戻る"
          onPress={returnFromTrivia}
          style={styles.backButton}>
          <Text style={styles.backArrow}>‹</Text>
          <Text style={styles.backText}>家事一覧に戻る</Text>
        </Pressable>
        <SectionHeading title="見出しを選択" trailing={<Text style={styles.resultCount}>{matchingTriviaItems.length}件</Text>} />
        {matchingTriviaItems.length > 0 ? (
          <View style={styles.choreList}>
            {matchingTriviaItems.map((item) => (
              <TriviaListRow key={item.id} item={item} onPress={() => setSelectedTriviaId(item.id)} />
            ))}
          </View>
        ) : <Card><Text style={styles.body}>一致する豆知識はありません。</Text></Card>}
      </Page>
    );
  }

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
        <ScreenHeading
          title="家事の説明"
          description={selectedCategory
            ? `${selectedCategory}に分類されている家事です。`
            : '分類を選ぶか、見出しから家事を検索してください。'}
        />
        {error ? <Card><Text style={styles.error}>{error}</Text></Card> : null}
        <TextInput
          accessibilityLabel="家事名を検索"
          autoCapitalize="none"
          clearButtonMode="while-editing"
          onChangeText={setSearchText}
          placeholder="家事の見出しで検索"
          placeholderTextColor={palette.muted}
          returnKeyType="search"
          style={styles.searchInput}
          value={searchText}
        />
        {chores.length > 0 ? (
          <>
            {!query && !selectedCategory ? (
              <>
                <SectionHeading title="分類を選ぶ" trailing={<Text style={styles.resultCount}>{categories.length}分類</Text>} />
                <View style={styles.choreList}>
                  {categories.map((category) => (
                    <GuideCategoryRow
                      key={category}
                      category={category}
                      count={chores.filter((chore) => chore.category === category).length}
                      onPress={() => setSelectedCategory(category)}
                    />
                  ))}
                </View>
                <GuideCategoryRow
                  category="豆知識"
                  count={triviaItems.length}
                  countLabel="件の豆知識"
                  onPress={() => {
                    setSelectedCategory(null);
                    setSearchText('');
                    setIsTriviaCollectionOpen(true);
                  }}
                />
              </>
            ) : (
              <>
                {selectedCategory ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="分類一覧に戻る"
                    onPress={() => setSelectedCategory(null)}
                    style={styles.backButton}>
                    <Text style={styles.backArrow}>‹</Text>
                    <Text style={styles.backText}>分類一覧へ戻る</Text>
                  </Pressable>
                ) : null}
                {query ? (
                  <SectionHeading
                    title="検索結果"
                    trailing={<Text style={styles.resultCount}>{matchingChores.length}件</Text>}
                  />
                ) : (
                  <SectionHeading
                    title={selectedCategory ?? '家事一覧'}
                    trailing={<Text style={styles.resultCount}>{matchingChores.length}件</Text>}
                  />
                )}
                {query && matchingChores.length === 0
                  ? <Card><Text style={styles.body}>見出しに一致する家事はありません。</Text></Card>
                  : null}
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
            )}
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

      <OtherChoresPicker
        key={selectedChoreId}
        chores={chores}
        selectedChoreId={selectedChoreId}
      />
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

function shuffleChores(chores: ChoreDefinition[]): ChoreDefinition[] {
  const shuffled = [...chores];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
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

function GuideCategoryRow({
  category,
  count,
  countLabel = '件の家事',
  onPress,
}: {
  category: string;
  count: number;
  countLabel?: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${category}、${count}件`}
      onPress={onPress}
      style={({ pressed }) => [styles.choreListRow, pressed && styles.choreListRowPressed]}>
      <View style={styles.choreListCopy}>
        <Text style={styles.choreListName}>{category}</Text>
        <Text style={styles.choreListCategory}>{count}{countLabel}</Text>
      </View>
      <Text style={styles.choreListChevron}>›</Text>
    </Pressable>
  );
}

function TriviaListRow({ item, onPress }: {
  item: { id: string; chore: ChoreDefinition; trivia: NonNullable<ChoreDefinition['trivia']>[number] };
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${item.trivia.title}、${item.chore.name}`}
      onPress={onPress}
      style={({ pressed }) => [styles.choreListRow, pressed && styles.choreListRowPressed]}>
      <View style={styles.choreListCopy}>
        <Text style={styles.choreListName}>{item.trivia.title}</Text>
        <Text style={styles.choreListCategory}>{item.chore.name}</Text>
      </View>
      <Text style={styles.choreListChevron}>›</Text>
    </Pressable>
  );
}

function OtherChoresPicker({
  chores,
  selectedChoreId,
}: {
  chores: ChoreDefinition[];
  selectedChoreId: string;
}) {
  const [chorePickerOrder] = useState(() => shuffleChores(chores));
  if (chores.length <= 1) return null;

  return (
    <View style={styles.otherChores}>
      <SectionHeading title="ほかの家事" />
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chorePicker}>
        {chorePickerOrder.map((chore) => (
          <Pressable
            key={chore.id}
            accessibilityRole="button"
            accessibilityState={{ selected: selectedChoreId === chore.id }}
            onPress={() => router.setParams({ choreId: chore.id })}
            style={[styles.choreOption, selectedChoreId === chore.id && styles.choreOptionSelected]}>
            <Text style={[styles.choreOptionText, selectedChoreId === chore.id && styles.choreOptionTextSelected]}>{chore.name}</Text>
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}

function ChoreGuide({ chore }: { chore: ChoreDefinition }) {
  return (
    <>
      <ScreenHeading title={chore.name} description={chore.description} />
      <Card>
        <SectionHeading title="家事の手順" />
        {chore.procedureSections?.length ? chore.procedureSections.map((section) => (
          <View key={section.title} style={styles.procedureSection}>
            <Text style={styles.procedureTitle}>{section.title}</Text>
            {section.steps.map((step, index) => <ProcedureStep key={`${index}-${step}`} step={step} index={index} />)}
          </View>
        )) : chore.instructions.length > 0 ? chore.instructions.map((step, index) => (
          <ProcedureStep key={`${index}-${step}`} step={step} index={index} />
        )) : <Text style={styles.body}>手順はまだ登録されていません。</Text>}
        {chore.sourceNotes?.length ? <Text style={styles.sourceNotes}>参考：{chore.sourceNotes.join('・')}</Text> : null}
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
      {chore.trivia?.length ? (
        <Card style={styles.triviaCard}>
          <Text style={styles.triviaHeading}>豆知識</Text>
          {chore.trivia.map((trivia) => (
            <View key={trivia.id} style={styles.triviaItem}>
              <Text style={styles.triviaTitle}>{trivia.title}</Text>
              <Text style={styles.triviaBody}>{trivia.body}</Text>
            </View>
          ))}
        </Card>
      ) : null}
    </>
  );
}

function ProcedureStep({ step, index }: { step: string; index: number }) {
  return (
    <View style={styles.stepRow}>
      <Text style={styles.stepNumber}>{String(index + 1).padStart(2, '0')}</Text>
      <Text style={styles.stepText}>{step}</Text>
    </View>
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
  procedureSection: { gap: 10 },
  procedureTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  stepNumber: { width: 25, color: palette.accent, fontSize: 13, fontWeight: '800', paddingTop: 1 },
  stepText: { flex: 1, color: palette.ink, fontSize: 14, lineHeight: 21 },
  toolList: { gap: 7 },
  toolText: { color: palette.ink, fontSize: 14, lineHeight: 21 },
  cautionCard: { backgroundColor: '#FBF5EB', borderColor: '#F0E4CD' },
  cautionHeading: { color: '#8D682E', fontSize: 14, fontWeight: '700' },
  cautionText: { color: '#765A31', fontSize: 13, lineHeight: 20 },
  triviaCard: { backgroundColor: palette.accentSoft, borderColor: palette.border, gap: 10 },
  triviaHeading: { color: palette.accent, fontSize: 15, fontWeight: '800' },
  triviaItem: { gap: 5 },
  triviaTitle: { color: palette.ink, fontSize: 14, fontWeight: '700' },
  triviaBody: { color: palette.ink, fontSize: 13, lineHeight: 20 },
  sourceNotes: { color: palette.muted, fontSize: 11, lineHeight: 16, paddingTop: 4 },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  error: { color: palette.warning, fontSize: 13 },
});
