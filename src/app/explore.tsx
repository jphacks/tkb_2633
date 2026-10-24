import { StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export default function CalendarScreen() {
  return (
    <SafeAreaView style={styles.safeArea}>
      <View style={styles.content}>
        <Text style={styles.eyebrow}>SCHEDULE</Text>
        <Text style={styles.title}>カレンダー</Text>
        <View style={styles.card}>
          <Text style={styles.cardTitle}>月間表示の接続枠</Text>
          <Text style={styles.body}>
            家事スケジュールを端末内で生成し、実施期間として表示する画面です。
          </Text>
        </View>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: '#F7F6F2' },
  content: { flex: 1, paddingHorizontal: 22, paddingTop: 24, gap: 18 },
  eyebrow: { color: '#477A62', fontSize: 11, fontWeight: '700', letterSpacing: 1.5 },
  title: { color: '#21312B', fontSize: 30, fontWeight: '700', marginTop: -10 },
  card: { backgroundColor: '#FFFFFF', borderRadius: 20, padding: 20, gap: 8 },
  cardTitle: { color: '#21312B', fontSize: 17, fontWeight: '700' },
  body: { color: '#748078', fontSize: 14, lineHeight: 21 },
});
