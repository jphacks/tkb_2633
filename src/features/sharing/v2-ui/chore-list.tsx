import { useState } from 'react';
import type { ReactElement } from 'react';
import { FlatList, Text, View } from 'react-native';
import { AppButton, Card, palette, typography } from '../../../components/planner-ui';
import type { V2GroupScreenModel } from '../v2/controller';
import { V2TextField } from './form-controls';

/** Keep large custom catalogs virtualized; the home screen only provides the entry point. */
export function V2ChoreList({ model, busy, onDetails, onConfiguration, onAdd, header }: { model: V2GroupScreenModel; busy: boolean;
  onDetails: (id: string) => void; onConfiguration: (id: string) => void; onAdd?: () => void; header?: ReactElement }) {
  const [query, setQuery] = useState(''); const search = query.normalize('NFKC').toLocaleLowerCase('ja');
  const rows = model.plan.chores.filter((chore) => !chore.archived && chore.name.normalize('NFKC').toLocaleLowerCase('ja').includes(search.trim()));
  const admin = model.viewerUserId === model.adminUserId;
  const configured = new Set(model.configurations.filter((row) => row.configuration).map((row) => row.choreId));
  return <FlatList data={rows} keyExtractor={(chore) => chore.id} initialNumToRender={8} contentContainerStyle={{ padding: 16, gap: 14, paddingBottom: 40 }}
    ListHeaderComponent={<View style={{ gap: 14 }}>{header}{onAdd ? <AppButton title="新しい共有家事を追加" variant="secondary" disabled={busy} onPress={onAdd} /> : null}
      <V2TextField label="共有家事を検索" value={query} onChangeText={setQuery} placeholder="家事名で検索" />
      <Text style={[typography.caption, { color: palette.muted }]}>{rows.length}件</Text></View>}
    ListEmptyComponent={<Card><Text style={[typography.body, { color: palette.ink }]}>該当する共有家事はありません。</Text></Card>}
    renderItem={({ item }) => <Card><Text style={[typography.subheading, { color: palette.ink, fontWeight: '600' }]}>{item.name}</Text>
      <Text style={[typography.caption, { color: palette.muted }]}>{model.plan.issues.some((issue) => issue.choreId === item.id && issue.kind.startsWith('fieldConflict')) ? '編集内容の確認が必要です' : !configured.has(item.id) ? '周期・担当が未設定です' : item.enabled ? '有効' : '無効'}</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AppButton title="名前・手順を編集" accessibilityLabel={`「${item.name}」の名前・手順を編集`} compact variant="secondary" disabled={busy} onPress={() => onDetails(item.id)} />
        {admin ? <AppButton title="周期・担当の設定" accessibilityLabel={`「${item.name}」の周期・担当の設定`} compact variant="quiet" disabled={busy} onPress={() => onConfiguration(item.id)} /> : null}
      </View>
    </Card>} />;
}
