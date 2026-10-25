import * as Linking from 'expo-linking';
import { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { palette, typography } from '@/components/planner-ui';

export function ChoreSourceLinks({ sources }: { sources: readonly string[] | undefined }) {
  const [error, setError] = useState<string | null>(null);
  const urls = [...new Set(sources?.filter((source) => /^https?:\/\/\S+$/i.test(source)) ?? [])];
  if (urls.length === 0) return null;

  const openSource = async (url: string) => {
    setError(null);
    try {
      await Linking.openURL(url);
    } catch {
      setError('参照元を開けませんでした。もう一度タップしてください。');
    }
  };

  return (
    <View style={styles.container}>
      <Text style={styles.label}>参照元</Text>
      {urls.map((url) => (
        <Text
          key={url}
          accessibilityRole="link"
          accessibilityLabel={`参照元を開く：${url}`}
          onPress={() => void openSource(url)}
          style={styles.link}>
          {url}
        </Text>
      ))}
      {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { gap: 6, paddingTop: 4 },
  label: { ...typography.caption, color: palette.muted, fontWeight: '600' },
  link: { ...typography.caption, color: palette.accent, textDecorationLine: 'underline' },
  error: { ...typography.caption, color: palette.warning },
});
