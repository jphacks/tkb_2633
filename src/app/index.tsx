import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

const colors = {
  background: '#F7F6F2',
  surface: '#FFFFFF',
  ink: '#21312B',
  muted: '#748078',
  accent: '#477A62',
  border: '#E5E8E3',
};

export default function HomeScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <ScrollView contentContainerStyle={styles.content}>
        <Text style={styles.eyebrow}>HOUSEWORK, IN GOOD TIME</Text>
        <Text style={styles.title}>家事のお知らせ</Text>
        <Text style={styles.subtitle}>今日やることを、無理のないペースで。</Text>

        <View style={styles.primaryCard}>
          <Text style={styles.cardLabel}>次の家事</Text>
          <Text style={styles.cardTitle}>スケジュールを準備しています</Text>
          <Text style={styles.cardBody}>
            家事を登録すると、実施期間と次の予定がここに表示されます。
          </Text>
        </View>

        <Text style={styles.sectionTitle}>このアプリの土台</Text>
        <View style={styles.listCard}>
          <FeatureRow title="端末内の保存" detail="オフラインで使う家事データ" />
          <FeatureRow title="曜日ごとのゴミ収集" detail="例外ルールは後から追加" />
          <FeatureRow title="天気・AI連携" detail="外部機能を追加できる接続口" />
          <FeatureRow title="通知・ウィジェット" detail="iOS / Android の拡張枠" last />
        </View>

        <Text style={styles.footer}>機能の詳細は、決まり次第ここへつなぎます。</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

function FeatureRow({
  title,
  detail,
  last = false,
}: {
  title: string;
  detail: string;
  last?: boolean;
}) {
  return (
    <View style={[styles.featureRow, !last && styles.featureDivider]}>
      <View style={styles.featureCopy}>
        <Text style={styles.featureTitle}>{title}</Text>
        <Text style={styles.featureDetail}>{detail}</Text>
      </View>
      <View style={styles.readyDot} />
    </View>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  content: { paddingHorizontal: 22, paddingTop: 24, paddingBottom: 40, gap: 18 },
  eyebrow: { color: colors.accent, fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: colors.ink, fontSize: 30, fontWeight: '700', marginTop: -10 },
  subtitle: { color: colors.muted, fontSize: 15, marginTop: -12 },
  primaryCard: {
    backgroundColor: colors.accent,
    borderRadius: 24,
    padding: 22,
    gap: 10,
    marginTop: 4,
  },
  cardLabel: { color: '#DCE9DF', fontSize: 13, fontWeight: '600' },
  cardTitle: { color: '#FFFFFF', fontSize: 21, fontWeight: '700' },
  cardBody: { color: '#E8F0EA', fontSize: 14, lineHeight: 21 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '700', marginTop: 4 },
  listCard: { backgroundColor: colors.surface, borderRadius: 20, paddingHorizontal: 16 },
  featureRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingVertical: 15 },
  featureDivider: { borderBottomColor: colors.border, borderBottomWidth: StyleSheet.hairlineWidth },
  featureCopy: { gap: 4 },
  featureTitle: { color: colors.ink, fontSize: 14, fontWeight: '600' },
  featureDetail: { color: colors.muted, fontSize: 12 },
  readyDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent },
  footer: { color: colors.muted, fontSize: 12, textAlign: 'center', marginTop: 2 },
});
