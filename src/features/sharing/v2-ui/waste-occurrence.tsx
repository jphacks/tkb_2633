import { Text, View } from 'react-native';
import { AppButton, palette, typography } from '../../../components/planner-ui';
import { WasteOccurrenceCard } from '../../../components/waste-occurrence-card';
import type { V2GroupController } from '../v2/controller';
import type { V2WasteOccurrence as WasteEntry } from '../v2/waste-state';

/** An unresolved hide/show decision stays visible and cannot masquerade as an unchecked box. */
export function V2WasteOccurrence({ entry, compact, busy, actions, run }: {
  entry: WasteEntry; compact?: boolean; busy: boolean; actions: V2GroupController['actions'];
  run: (work: () => Promise<unknown>) => Promise<void>;
}) {
  return <View style={{ gap: 6 }}>
    <WasteOccurrenceCard occurrence={entry.occurrence} compact={compact} hidden={entry.hidden === true} busy={busy || entry.hidden === null}
      onToggle={() => void run(() => actions.setWasteOccurrenceHidden(entry.selection, !entry.hidden))} />
    {entry.hidden === null ? <View style={{ gap: 6 }}>
      <Text style={{ ...typography.caption, color: palette.warning }}>表示と非表示の変更が重なりました。この収集日の扱いを選んでください。</Text>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <AppButton title="この収集日を表示する" compact variant="quiet" disabled={busy} onPress={() => void run(() => actions.setWasteOccurrenceHidden(entry.selection, false, true))} />
        <AppButton title="この収集日を非表示にする" compact variant="quiet" disabled={busy} onPress={() => void run(() => actions.setWasteOccurrenceHidden(entry.selection, true, true))} />
      </View>
    </View> : null}
  </View>;
}
