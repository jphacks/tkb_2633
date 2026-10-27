import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { AppButton, Card, palette, SectionHeading, typography } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import type { LocalDate } from '../../../domain/shared/types';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { SharedChoreConfiguration } from '../v2/model';
import { useV2ConfigurationAutosave } from './use-configuration-autosave';

/** Only an authenticated administrator receives the editor; receiver authority remains the final check. */
export function V2ConfigurationEditor({ model, choreId, controller, onSaved }: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void> }) {
  if (model.viewerUserId !== model.adminUserId) return <Text style={styles.caption}>周期と有効状態は管理者が変更します。</Text>;
  const row = model.configurations.find((entry) => entry.choreId === choreId);
  if (!row?.configuration) return <Text style={styles.caption}>{row?.candidates.length ? '設定が競合しています。候補を確認して解決してください。' : '周期・基準日・家事の種類を設定してください。'}</Text>;
  return <Editor key={`${model.plan.groupId}:${choreId}`} configuration={row.configuration} earliestFrom={row.earliestEffectiveFrom}
    today={model.plan.range.asOfDate} choreId={choreId} controller={controller} onSaved={onSaved} />;
}

function Editor({ configuration, earliestFrom, today, choreId, controller, onSaved }: { configuration: SharedChoreConfiguration;
  earliestFrom: LocalDate; today: LocalDate; choreId: string; controller: V2GroupController; onSaved: () => Promise<void> }) {
  const [from, setFrom] = useState<LocalDate>(today > earliestFrom ? today : earliestFrom); const [fromError, setFromError] = useState<string | null>(null);
  const autosave = useV2ConfigurationAutosave({ configuration, effectiveFrom: from,
    save: (edits, date) => controller.actions.patchChoreConfigurationFields(choreId, edits, date), onSaved });
  const saving = autosave.status.phase === 'pending' || autosave.status.phase === 'saving';
  const date = (text: string) => {
    try { parseLocalDate(text as LocalDate); if (text < earliestFrom) throw new Error('Boundary'); setFromError(null); }
    catch { setFromError(`適用開始日は${earliestFrom}以降の日付にしてください。`); }
    setFrom(text as LocalDate);
  };
  return <Card>
    <SectionHeading title="共通の周期・実施期間" />
    <Text style={styles.label}>変更の適用開始日</Text>
    <TextInput accessibilityLabel="共有設定の適用開始日" value={from} onChangeText={date} editable={!saving && !autosave.hasDraft()}
      onEndEditing={() => { if (!fromError) void autosave.flush(); }} autoCapitalize="none" style={styles.input} />
    {fromError ? <Text accessibilityRole="alert" style={styles.error}>{fromError}</Text> : null}
    <Text style={styles.caption}>保存中の変更には同じ適用開始日を使います。完了済みの履歴は保持されます。</Text>
    <View style={styles.row}><Text style={styles.label}>家事を有効にする</Text><Switch accessibilityLabel="共有家事を有効にする" value={autosave.draft.active}
      disabled={Boolean(fromError)} onValueChange={autosave.changeActive} /></View>
    <Text style={styles.label}>基準日</Text>
    <TextInput accessibilityLabel="共有家事の基準日" value={autosave.draft.anchorDate} onChangeText={autosave.changeAnchor}
      onEndEditing={() => void autosave.flush()} editable={!fromError} autoCapitalize="none" style={styles.input} />
    {autosave.anchorError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.anchorError}</Text> : null}
    {(['intervalDays', 'windowBeforeDays', 'windowAfterDays'] as const).map((field) => {
      const label = field === 'intervalDays' ? '周期' : field === 'windowBeforeDays' ? '基準日より前' : '基準日より後'; const error = autosave.numberError(field);
      return <View key={field}><View style={styles.row}><Text style={styles.label}>{label}</Text>
        <NumberInputField accessibilityLabel={`共有家事の${label}`} value={autosave.draft[field]} editable={!fromError}
          onChangeText={(text) => autosave.changeNumber(field, text)} onEndEditing={() => void autosave.flush()} /></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>;
    })}
    <Text accessibilityLiveRegion="polite" style={autosave.status.phase === 'error' ? styles.error : styles.caption}>
      {autosave.status.error ?? (saving ? '端末へ保存中…' : autosave.status.phase === 'saved' ? '端末に保存しました。共有状況は同期表示で確認できます。' : '変更は自動で保存されます。')}</Text>
    {autosave.refreshError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.refreshError}</Text> : null}
    {autosave.status.phase === 'error' ? <AppButton title="保存を再試行" variant="secondary" onPress={() => void autosave.flush()} /> : null}
    {autosave.hasDraft() ? <AppButton title="入力を最新の設定に戻す" variant="quiet" onPress={autosave.discard} /> : null}
  </Card>;
}
const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
  label: { ...typography.label, color: palette.ink, flexShrink: 1 }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning }, input: { ...typography.body, color: palette.ink, borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, paddingHorizontal: 12, minHeight: 46 },
});
