import { useState } from 'react';
import { StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { AppButton, BackButton, Card, palette, SectionHeading, typography } from '../../../components/planner-ui';
import { NumberInputField } from '../../../components/number-input-field';
import type { LocalDate } from '../../../domain/shared/types';
import { parseLocalDate } from '../../../domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { SharedChoreConfiguration } from '../v2/model';
import { useV2ConfigurationAutosave } from './use-configuration-autosave';
import { canonicalJson } from '../operations';
import { V2StaleSettingsError } from '../v2/configuration-edit';
import { V2InitialConfiguration } from './initial-configuration';

/** Only an authenticated administrator receives the editor; receiver authority remains the final check. */
export function V2ConfigurationEditor(props: { model: V2GroupScreenModel; choreId: string;
  controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void }) {
  const { model, choreId } = props;
  if (model.viewerUserId !== model.adminUserId) return <View style={styles.container}>{props.onBack ? <BackButton onPress={props.onBack} /> : null}
    <Text style={styles.caption}>周期と有効状態は管理者が変更します。</Text></View>;
  return <RetainedEditor key={`${model.plan.groupId}:${choreId}`} {...props} />;
}

function RetainedEditor({ model, choreId, controller, onSaved, onBack }: Parameters<typeof V2ConfigurationEditor>[0]) {
  const row = model.configurations.find((entry) => entry.choreId === choreId);
  const [retained, setRetained] = useState(row?.configuration ?? null);
  // Retain the editor (and its draft store) when a remote conflict temporarily removes the resolved value.
  if (row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion && canonicalJson(row.configuration) !== canonicalJson(retained))) setRetained(row.configuration);
  const configuration = row?.configuration && (!retained || row.configuration.ruleVersion >= retained.ruleVersion) ? row.configuration : retained;
  if (!configuration) return row?.candidates.length ? <Text style={styles.caption}>設定が競合しています。候補を確認して解決してください。</Text>
    : <V2InitialConfiguration model={model} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} />;
  const boundary = configuration.effectiveFrom ?? configuration.anchorDate;
  const earliestFrom = row?.earliestEffectiveFrom && row.earliestEffectiveFrom > boundary ? row.earliestEffectiveFrom : boundary;
  return <Editor configuration={configuration} earliestFrom={earliestFrom}
    today={model.plan.range.asOfDate} choreId={choreId} controller={controller} onSaved={onSaved} onBack={onBack} blocked={!row?.configuration} />;
}

function Editor({ configuration, earliestFrom, today, choreId, controller, onSaved, onBack, blocked }: { configuration: SharedChoreConfiguration;
  earliestFrom: LocalDate; today: LocalDate; choreId: string; controller: V2GroupController; onSaved: () => Promise<void>; onBack?: () => void; blocked: boolean }) {
  const [from, setFrom] = useState<LocalDate>(today > earliestFrom ? today : earliestFrom); const [fromError, setFromError] = useState<string | null>(null);
  const [fromBasis, setFromBasis] = useState(earliestFrom);
  const autosave = useV2ConfigurationAutosave({ configuration, effectiveFrom: from,
    save: (edits, date) => { if (blocked) return Promise.reject(new V2StaleSettingsError()); return controller.actions.patchChoreConfigurationFields(choreId, edits, date); }, onSaved });
  const saving = autosave.status.phase === 'pending' || autosave.status.phase === 'saving';
  if (fromBasis !== earliestFrom && !autosave.hasDraft() && !saving) {
    setFromBasis(earliestFrom); if (!fromError && from < earliestFrom) setFrom(earliestFrom);
  }
  const date = (text: string) => {
    try { parseLocalDate(text as LocalDate); if (text < earliestFrom) throw new Error('Boundary'); setFromError(null); }
    catch { setFromError(`適用開始日は${earliestFrom}以降の日付にしてください。`); }
    setFrom(text as LocalDate);
  };
  return <View style={styles.container}>
    {onBack ? <BackButton disabled={autosave.leaving} onPress={() => void autosave.navigateAfterSave(onBack)} /> : null}
    <Card>
    {blocked ? <Text accessibilityRole="alert" style={styles.error}>設定が競合しています。入力は保持しています。候補を確認して解決するか、入力を戻してください。</Text> : null}
    <SectionHeading title="共通の周期・実施期間" />
    <Text style={styles.label}>変更の適用開始日</Text>
    <TextInput accessibilityLabel="共有設定の適用開始日" value={from} onChangeText={date} editable={!blocked && !saving && !autosave.hasDraft()}
      onEndEditing={() => { if (!fromError) void autosave.flush(); }} autoCapitalize="none" style={styles.input} />
    {fromError ? <Text accessibilityRole="alert" style={styles.error}>{fromError}</Text> : null}
    <Text style={styles.caption}>保存中の変更には同じ適用開始日を使います。完了済みの履歴は保持されます。</Text>
    <View style={styles.row}><Text style={styles.label}>家事を有効にする</Text><Switch accessibilityLabel="共有家事を有効にする" value={autosave.draft.active}
      disabled={blocked || Boolean(fromError)} onValueChange={autosave.changeActive} /></View>
    <Text style={styles.label}>基準日</Text>
    <TextInput accessibilityLabel="共有家事の基準日" value={autosave.draft.anchorDate} onChangeText={autosave.changeAnchor}
      onEndEditing={() => void autosave.flush()} editable={!blocked && !fromError} autoCapitalize="none" style={styles.input} />
    {autosave.anchorError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.anchorError}</Text> : null}
    {(['intervalDays', 'windowBeforeDays', 'windowAfterDays'] as const).map((field) => {
      const label = field === 'intervalDays' ? '周期' : field === 'windowBeforeDays' ? '基準日より前' : '基準日より後'; const error = autosave.numberError(field);
      return <View key={field}><View style={styles.row}><Text style={styles.label}>{label}</Text>
        <NumberInputField accessibilityLabel={`共有家事の${label}`} value={autosave.draft[field]} editable={!blocked && !fromError}
          onChangeText={(text) => autosave.changeNumber(field, text)} onEndEditing={() => void autosave.flush()} /></View>
        {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}</View>;
    })}
    <Text accessibilityLiveRegion="polite" style={autosave.status.phase === 'error' ? styles.error : styles.caption}>
      {autosave.status.error ?? (saving ? '端末へ保存中…' : autosave.status.phase === 'saved' ? '端末に保存しました。共有状況は同期表示で確認できます。' : '変更は自動で保存されます。')}</Text>
    {autosave.refreshError ? <Text accessibilityRole="alert" style={styles.error}>{autosave.refreshError}</Text> : null}
    {autosave.status.phase === 'error' ? <AppButton title="保存を再試行" variant="secondary" onPress={() => void autosave.flush()} /> : null}
    {autosave.hasDraft() ? <AppButton title="入力を最新の設定に戻す" variant="quiet" onPress={autosave.discard} /> : null}
    </Card>
  </View>;
}
const styles = StyleSheet.create({
  container: { gap: 14 },
  row: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 12, paddingVertical: 6 },
  label: { ...typography.label, color: palette.ink, flexShrink: 1 }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning }, input: { ...typography.body, color: palette.ink, borderWidth: 1, borderColor: palette.border,
    borderRadius: 11, paddingHorizontal: 12, minHeight: 46 },
});
