import { router } from 'expo-router';
import { StyleSheet, Text } from 'react-native';

import { AppButton, BackButton, Card, Page, ScreenHeading, SectionHeading, palette, typography } from '@/components/planner-ui';

export default function HelpScreen() {
  return (
    <Page>
      <BackButton onPress={() => router.back()} />
      <ScreenHeading eyebrow="HELP" title="アプリの使い方" description="家事の予定を確認し、手順や道具を見ながら進められます。" />

      <Card>
        <SectionHeading title="ホーム" />
        <Text style={styles.body}>今日の家事と、今週・来週に予定されている家事を確認できます。</Text>
        <Text style={styles.body}>家事名を押すと手順の説明が開きます。右のチェックを押すと完了し、完了後にもう一度押すと未完了に戻せます。</Text>
      </Card>

      <Card>
        <SectionHeading title="カレンダー" />
        <Text style={styles.body}>日付を押すと、その日の家事を確認できます。左右の矢印で月を移動できます。</Text>
        <Text style={styles.body}>日付と矢印以外のカレンダー部分を押すと、選択日にかかる家事の実施期間を横棒で表示します。もう一度押すと閉じます。</Text>
        <Text style={styles.hint}>実施期間は、その家事を行える日付の幅です。おすすめ日は期間内の目安として表示します。</Text>
      </Card>

      <Card>
        <SectionHeading title="家事" />
        <Text style={styles.body}>検索欄は家事の見出しを入力するたびに絞り込みます。家事を選ぶと、手順・必要な道具・注意事項を確認できます。</Text>
        <Text style={styles.body}>個別設定は家事一覧の「個別設定」から、実施履歴は家事の説明画面から確認できます。</Text>
      </Card>

      <Card>
        <SectionHeading title="家電" />
        <Text style={styles.body}>メーカー名・製品名・型番から家電を登録し、確認できた公式情報やお手入れ内容を参照できます。</Text>
        <Text style={styles.hint}>公式情報の確認にはインターネット接続が必要です。</Text>
      </Card>

      <Card>
        <SectionHeading title="設定" />
        <Text style={styles.body}>家事の頻度、休日、通知、天気を確認する地域などは設定で調整できます。この画面の「設定を開く」から移動できます。</Text>
        <Text style={styles.hint}>天気連動を使う場合は地域を設定してください。通知の許可は端末の設定から変更できます。</Text>
      </Card>

      <AppButton title="設定を開く" onPress={() => router.push('/settings')} variant="secondary" />
    </Page>
  );
}

const styles = StyleSheet.create({
  body: { ...typography.body, color: palette.ink },
  hint: { ...typography.caption, color: palette.muted },
});
