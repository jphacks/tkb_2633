import { Text } from 'react-native';
import { V2GroupScreen } from '../v2-ui/group-screen';
import type { V2GroupScreenProps } from '../v2-ui/group-screen';

/** Release builds never open the synthetic session. The authenticated workspace uses a separate route. */
export function V2DevelopmentPreviewScreen(props: Omit<V2GroupScreenProps, 'purpose'> & { development: boolean }) {
  if (!props.development) return <Text>この画面は開発ビルド専用です。</Text>;
  return <V2GroupScreen {...props} purpose="development" />;
}
