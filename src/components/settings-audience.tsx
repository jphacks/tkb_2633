import { StyleSheet, Text, View } from 'react-native';
import { GroupIcon, PersonIcon } from './group-icon';
import { palette, typography } from './planner-ui';

/** Lives in the fixed settings header, once per document. */
export function SettingsAudience({ groupName }: { groupName?: string }) {
  return <View style={styles.audience}><View aria-hidden>{groupName === undefined ? <PersonIcon size={21} /> : <GroupIcon size={26} />}</View>
    <Text numberOfLines={2} style={styles.label}>{groupName === undefined ? '個人用' : `グループ用 · ${groupName}`}</Text></View>;
}
const styles = StyleSheet.create({
  audience: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: 6, flexShrink: 1 },
  label: { ...typography.label, color: palette.muted, flexShrink: 1 },
});
