import { SymbolView } from 'expo-symbols';
import { palette } from './planner-colors';
export function GroupIcon({ size = 23 }: { size?: number }) {
  return <SymbolView name={{ ios: 'person.3.fill', android: 'groups' }} size={size} tintColor={palette.muted} weight="regular" />;
}
export function PersonIcon({ size = 23 }: { size?: number }) {
  return <SymbolView name={{ ios: 'person.fill', android: 'person' }} size={size} tintColor={palette.muted} weight="regular" />;
}
