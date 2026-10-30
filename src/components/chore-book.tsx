import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { FlatList, Platform, StyleSheet, Text, View } from 'react-native';
import type { ListViewToken } from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';
import type { ChoreDefinition } from '../domain/chores/types';
import { groupChores } from '../domain/chores/chore-groups';
import { BackButton, palette, typography } from './planner-ui';
import { ChoreCategoryRail } from './chore-category-rail';

/** A continuous, virtualized document. The dock and category rail never scroll away. */
export function ChoreBook({ chores, selectedId, renderChore, onBack, header, title, titleAccessory, hasTabBar = false }: {
  chores: readonly ChoreDefinition[]; selectedId?: string; title: string; header?: ReactNode;
  titleAccessory?: ReactNode;
  renderChore(chore: ChoreDefinition): ReactNode; onBack(): void;
  hasTabBar?: boolean;
}) {
  const groups = useMemo(() => groupChores(chores), [chores]);
  const ordered = useMemo(() => groups.flatMap(([, rows]) => rows), [groups]);
  const list = useRef<FlatList<ChoreDefinition>>(null);
  const latest = useRef(ordered);
  useEffect(() => { latest.current = ordered; }, [ordered]);
  const target = useRef<string | null>(null); const retries = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [category, setCategory] = useState(ordered.find(row => row.id === selectedId)?.category ?? groups[0]?.[0] ?? '');
  const [visibleId, setVisibleId] = useState(selectedId ?? ordered[0]?.id);
  const scrubbing = useRef(false);
  const onScrubChange = useCallback((active: boolean) => { scrubbing.current = active; }, []);
  const insets = useSafeAreaInsets();
  const jump = useCallback((id: string) => {
    const index = latest.current.findIndex(row => row.id === id); if (index < 0) return;
    clearTimeout(timer.current);
    target.current = id; retries.current = 0;
    list.current?.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: 8 });
    setCategory(latest.current[index].category);
    setVisibleId(id);
  }, []);
  useEffect(() => {
    if (selectedId) timer.current = setTimeout(() => jump(selectedId), 0);
    return () => { clearTimeout(timer.current); target.current = null; };
  }, [selectedId, jump]);
  const visible = useCallback(({ viewableItems }: { viewableItems: ListViewToken[] }) => {
    const first = viewableItems.find(item => item.isViewable)?.item; if (first && !scrubbing.current) { setCategory(first.category); setVisibleId(first.id); }
  }, []);
  return <SafeAreaView style={styles.safe} edges={['top']}>
    <View style={styles.captionBar}><View style={styles.captionCopy}><Text style={styles.captionTitle}>{title}</Text><Text style={styles.caption}>{category}</Text></View>{titleAccessory}</View>
    <View style={styles.document}>
      <FlatList ref={list} data={ordered} keyExtractor={chore => chore.id} initialNumToRender={2} maxToRenderPerBatch={2} windowSize={5}
        removeClippedSubviews={false} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets={Platform.OS === 'ios'} contentContainerStyle={styles.content} ListHeaderComponent={<>{header}</>}
        onViewableItemsChanged={visible} viewabilityConfig={{ itemVisiblePercentThreshold: 1 }}
        onScrollBeginDrag={() => { target.current = null; clearTimeout(timer.current); }}
        onScrollToIndexFailed={info => {
          if (!target.current || retries.current++ >= 20) return;
          list.current?.scrollToOffset({ offset: info.averageItemLength * info.index, animated: false });
          clearTimeout(timer.current); timer.current = setTimeout(() => {
            const index = latest.current.findIndex(chore => chore.id === target.current);
            if (index >= 0) list.current?.scrollToIndex({ index, animated: false, viewPosition: 0, viewOffset: 8 });
          }, 120);
        }}
        renderItem={({ item, index }) => <View style={styles.chapter}>
          {index === 0 || ordered[index - 1].category !== item.category ? <Text style={styles.category}>{item.category}</Text> : null}
          {renderChore(item)}
        </View>} />
      <ChoreCategoryRail groups={groups.map(([name, chores]) => ({ name, chores }))} category={category} selectedId={visibleId} onSelect={jump} onScrubChange={onScrubChange} />
    </View>
    <View style={[styles.dock, { paddingBottom: hasTabBar ? 8 : Math.max(8, insets.bottom) }]}><BackButton onPress={onBack} /></View>
  </SafeAreaView>;
}
const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: palette.background }, document: { flex: 1 },
  captionBar: { paddingVertical: 8, paddingHorizontal: 18, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: palette.border,
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12 },
  captionCopy: { gap: 2, flexShrink: 0 },
  captionTitle: { ...typography.body, color: palette.ink, fontWeight: '700' }, caption: { ...typography.caption, color: palette.muted },
  content: { paddingLeft: 16, paddingRight: 42, paddingTop: 8, paddingBottom: 20, gap: 24, maxWidth: 820, width: '100%', alignSelf: 'center' },
  chapter: { gap: 12, paddingBottom: 18, borderBottomWidth: 1, borderBottomColor: palette.border },
  category: { ...typography.caption, color: palette.accent, fontWeight: '700', marginTop: 6 },
  dock: { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border, paddingHorizontal: 18, backgroundColor: palette.surface },
});
