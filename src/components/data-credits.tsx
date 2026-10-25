import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, View } from 'react-native';

import { Card, SectionHeading, palette, typography } from '@/components/planner-ui';

function CreditLink({ title, url }: { title: string; url: string }) {
  const [failed, setFailed] = useState(false);
  return <View>
    <Pressable accessibilityRole="link" onPress={() => {
      setFailed(false);
      void Linking.openURL(url).catch(() => setFailed(true));
    }} style={styles.linkArea}><Text style={styles.link}>{title} ↗</Text></Pressable>
    {failed ? <Text style={styles.error}>リンクを開けませんでした。</Text> : null}
  </View>;
}

export function WeatherAttribution() {
  return <CreditLink title="天気データ：Open-Meteo" url="https://open-meteo.com/" />;
}

export function LocationAttribution() {
  return <CreditLink title="地域データ：GeoNames（Open-Meteo経由）" url="https://www.geonames.org/" />;
}

export function DataCredits() {
  return <Card>
    <SectionHeading title="クレジット" />
    <WeatherAttribution />
    <LocationAttribution />
    <CreditLink title="データライセンス：CC BY 4.0" url="https://creativecommons.org/licenses/by/4.0/" />
    <Text style={styles.body}>天気予報はOpen-Meteo、地域検索はGeoNamesのデータを使用しています。取得したデータをもとに地域候補を日本語で表示し、洗濯予定の推奨日を調整しています。</Text>
  </Card>;
}

const styles = StyleSheet.create({
  linkArea: { minHeight: 44, justifyContent: 'center' },
  link: { ...typography.caption, color: palette.accent, fontWeight: '600', textDecorationLine: 'underline' },
  body: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
});
