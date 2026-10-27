import { Text, View } from 'react-native';
import { AppButton } from '../../../components/planner-ui';
import { v2FormStyles as styles } from './form-controls';

export type V2DateConfirmationKind = 'recentWork' | 'highLoad' | 'calendar';
export function V2DateConfirmation({ kind, disabled, onConfirm, onCancel, confirmLabel = '指定する' }: {
  kind: V2DateConfirmationKind; disabled: boolean; onConfirm: () => void; onCancel: () => void; confirmLabel?: string;
}) {
  return <View style={{ gap: 8 }}><Text accessibilityRole="alert" style={styles.error}>{kind === 'highLoad' ? 'この日は家事の負荷が高くなっています。この日に指定しますか？'
    : kind === 'recentWork' ? '最近実施されていますが、もう一度指定しますか？' : '指定する時間帯にはカレンダーに予定が入っています。本当に指定しますか？'}</Text>
    <AppButton title={confirmLabel} disabled={disabled} onPress={onConfirm} />
    <AppButton title="取り消す" variant="quiet" disabled={disabled} onPress={onCancel} />
  </View>;
}
