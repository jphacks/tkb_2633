import { router } from 'expo-router';
import { useSQLiteContext } from 'expo-sqlite';
import { useState } from 'react';
import { Linking, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ApplianceCareApiRequest, ApplianceCareApiResponse } from '@/features/appliance-care/api-contracts';
import { analyzeApplianceCareRequest } from '@/features/appliance-care/api-client';
import type { ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { addApprovedApplianceCareChores } from '@/platform/storage/repository';

const DEMO_PRODUCT: ApplianceCareApiRequest = {
  manufacturer: 'Dyson',
  productName: 'V12 Detect Slim',
  modelNumber: 'SV20',
  category: 'vacuum_cleaner',
};

export default function ApplianceCareScreen() {
  const database = useSQLiteContext();
  const [manufacturer, setManufacturer] = useState(DEMO_PRODUCT.manufacturer);
  const [productName, setProductName] = useState(DEMO_PRODUCT.productName);
  const [modelNumber, setModelNumber] = useState(DEMO_PRODUCT.modelNumber);
  const [category, setCategory] = useState(DEMO_PRODUCT.category ?? '');
  const [result, setResult] = useState<ApplianceCareApiResponse | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [cycleValues, setCycleValues] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  const verified = result?.status === 'verified' ? result : undefined;

  const analyze = async () => {
    const request = { manufacturer, productName, modelNumber, category };
    if ([request.manufacturer, request.productName, request.modelNumber].some((value) => !value.trim())) {
      setMessage('メーカー名・製品名・型番を入力してください。');
      return;
    }
    setWorking(true);
    setMessage(null);
    setResult(null);
    setSelectedIndices([]);
    try {
      const nextResult = await analyzeApplianceCareRequest(request);
      setResult(nextResult);
      if (nextResult.status === 'verified') {
        setCycleValues(Object.fromEntries(nextResult.analysis.tasks.map((task, index) => [
          index,
          task.recommendedIntervalDays === undefined ? '' : String(task.recommendedIntervalDays),
        ])));
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '公式資料の解析に失敗しました。');
    } finally {
      setWorking(false);
    }
  };

  const toggleTask = (index: number) => {
    setSelectedIndices((current) => current.includes(index)
      ? current.filter((value) => value !== index)
      : [...current, index]);
  };

  const addSelected = async () => {
    if (!verified || !verified.analysis.requiresUserReview) return;
    const approvedTasks = selectedIndices.map((index) => {
      const task = verified.analysis.tasks[index];
      const entered = cycleValues[index]?.trim();
      return {
        task,
        ...(entered ? { userCycleDays: Number(entered) } : {}),
      };
    });
    if (approvedTasks.some(({ userCycleDays }) => userCycleDays !== undefined
      && (!Number.isInteger(userCycleDays) || userCycleDays < 1 || userCycleDays > 3650))) {
      setMessage('周期は1〜3650日の整数で入力してください。');
      return;
    }
    if (approvedTasks.length === 0) {
      setMessage('登録するお手入れ項目を1件以上選択してください。');
      return;
    }

    setWorking(true);
    setMessage(null);
    try {
      await addApprovedApplianceCareChores(database, {
        manufacturer: verified.product.manufacturer,
        productName: verified.product.productName,
        modelNumber: verified.product.modelNumber,
        manualUrl: verified.officialSources.manualUrl,
      }, verified.analysis, approvedTasks);
      router.back();
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '家事へ追加できませんでした。');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Page>
      <Pressable accessibilityRole="button" onPress={() => router.back()}><Text style={styles.back}>‹  家事一覧</Text></Pressable>
      <ScreenHeading
        eyebrow="OFFICIAL MANUAL"
        title="家電のお手入れを調べる"
        description="入力したメーカーの公式情報だけで製品と取扱説明書を確認します。解析結果は確認してから家事に追加できます。"
      />

      <Card>
        <SectionHeading title="製品情報" />
        <Field label="メーカー名" value={manufacturer} onChangeText={setManufacturer} placeholder="例：Dyson" />
        <Field label="製品名" value={productName} onChangeText={setProductName} placeholder="例：V12 Detect Slim" />
        <Field label="型番" value={modelNumber} onChangeText={setModelNumber} placeholder="例：SV20" />
        <Field label="カテゴリ（任意）" value={category} onChangeText={setCategory} placeholder="例：vacuum_cleaner" />
        <Text style={styles.note}>検索を実行すると入力した製品情報と公式資料が外部サービスへ送られます。APIキーはアプリに保存せず、接続先サーバーだけで使用します。</Text>
        <AppButton title={working ? '公式情報を確認中…' : '公式資料を検索して解析'} onPress={() => void analyze()} disabled={working} />
      </Card>

      {message ? <Card><Text style={styles.message}>{message}</Text></Card> : null}
      {result?.status === 'not_found' ? (
        <Card><Text style={styles.resultTitle}>製品を確認できませんでした</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'error' ? (
        <Card><Text style={styles.resultTitle}>解析できませんでした</Text><Text style={styles.body}>{result.message}</Text><Text style={styles.note}>エラーコード：{result.code}</Text></Card>
      ) : null}
      {result?.status === 'ambiguous' ? (
        <Card>
          <SectionHeading title="候補を確認してください" />
          <Text style={styles.body}>公式情報に複数の候補があります。候補を選ぶと製品名・型番を入力欄へ戻します。必要に応じて内容を編集して再検索してください。</Text>
          {result.candidates.map((candidate, index) => (
            <View key={`${candidate.officialProductUrl}-${index}`} style={styles.candidate}>
              <Text style={styles.resultTitle}>{candidate.manufacturer} {candidate.productName}{candidate.modelNumber ? `（${candidate.modelNumber}）` : ''}</Text>
              <AppButton title="この候補を入力して再検索" onPress={() => {
                setManufacturer(candidate.manufacturer);
                setProductName(candidate.productName);
                if (candidate.modelNumber) setModelNumber(candidate.modelNumber);
                setCategory('');
                setResult(null);
              }} variant="secondary" compact />
              <ExternalLink title="公式製品情報を開く ↗" url={candidate.officialProductUrl} />
            </View>
          ))}
        </Card>
      ) : null}

      {verified ? (
        <>
          <Card style={styles.verifiedCard}>
            <Text style={styles.verifiedLabel}>メーカー公式情報で確認済み</Text>
            <Text style={styles.resultTitle}>{verified.product.manufacturer} {verified.product.productName}（{verified.product.modelNumber}）</Text>
            {verified.officialSources.productUrl ? <ExternalLink title="公式製品情報を開く ↗" url={verified.officialSources.productUrl} /> : null}
            <ExternalLink title="公式取扱説明書を開く ↗" url={verified.officialSources.manualUrl} />
            <Text style={styles.note}>解析日時：{verified.analysis.analyzedAt} · 登録前の確認が必要です</Text>
          </Card>
          <SectionHeading title="登録するお手入れ項目を選択" />
          {verified.analysis.tasks.map((task, index) => (
            <TaskReviewCard
              key={`${index}-${task.name}`}
              task={task}
              index={index}
              selected={selectedIndices.includes(index)}
              cycleValue={cycleValues[index] ?? ''}
              onToggle={() => toggleTask(index)}
              onChangeCycle={(value) => setCycleValues((current) => ({ ...current, [index]: value }))}
            />
          ))}
          <AppButton title={working ? '追加中…' : `選択した${selectedIndices.length}件を家事に追加`} onPress={() => void addSelected()} disabled={working || selectedIndices.length === 0} />
          <Text style={styles.note}>周期を決めていない項目は、後から詳細画面で周期を設定するまで予定に入りません。</Text>
        </>
      ) : null}
    </Page>
  );
}

function Field({ label, value, onChangeText, placeholder }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} style={styles.input} maxLength={120} autoCapitalize="words" />
    </View>
  );
}

function TaskReviewCard({ task, index, selected, cycleValue, onToggle, onChangeCycle }: {
  task: ApplianceCareTaskDraft;
  index: number;
  selected: boolean;
  cycleValue: string;
  onToggle: () => void;
  onChangeCycle: (value: string) => void;
}) {
  return (
    <Card>
      <Pressable accessibilityRole="checkbox" accessibilityState={{ checked: selected }} onPress={onToggle} style={styles.taskHeader}>
        <View style={[styles.checkbox, selected && styles.checkboxSelected]}><Text style={styles.checkmark}>{selected ? '✓' : ''}</Text></View>
        <View style={styles.taskHeading}>
          <Text style={styles.taskIndex}>お手入れ {String(index + 1).padStart(2, '0')}</Text>
          <Text style={styles.resultTitle}>{task.name}</Text>
        </View>
      </Pressable>
      <View style={styles.cycleRow}>
        <View style={styles.flexCopy}>
          <Text style={styles.fieldLabel}>周期</Text>
          {task.recommendedIntervalDays !== undefined
            ? <Text style={styles.body}>メーカー指定：{task.recommendedIntervalDays}日</Text>
            : <Text style={styles.body}>メーカー指定なし</Text>}
        </View>
        <View style={styles.cycleInputWrap}>
          <TextInput value={cycleValue} onChangeText={onChangeCycle} keyboardType="number-pad" style={styles.cycleInput} accessibilityLabel={`${task.name}の周期`} placeholder="任意" />
          <Text style={styles.fieldLabel}>日</Text>
        </View>
      </View>
      {task.recommendedConditions?.map((condition) => <Text key={condition} style={styles.body}>条件：{condition}</Text>)}
      <SectionHeading title="手順" />
      {task.steps.map((step, stepIndex) => <Text key={`${stepIndex}-${step}`} style={styles.body}>{stepIndex + 1}. {step}</Text>)}
      {task.tools.length ? <Text style={styles.body}>道具：{task.tools.join('、')}</Text> : <Text style={styles.body}>必要な道具：記載なし</Text>}
      {task.safetyCautions.length ? (
        <View style={styles.cautionBox}>
          <Text style={styles.cautionTitle}>注意事項</Text>
          {task.safetyCautions.map((caution) => <Text key={caution} style={styles.cautionText}>• {caution}</Text>)}
        </View>
      ) : null}
      {task.estimatedMinutes ? <Text style={styles.note}>所要時間：約{task.estimatedMinutes}分</Text> : null}
      {task.evidence.map((item, evidenceIndex) => (
        <ExternalLink key={`${item.url}-${evidenceIndex}`} title={`根拠資料${item.pageOrSection ? ` · ${item.pageOrSection}` : ''}を開く ↗`} url={item.url} />
      ))}
    </Card>
  );
}

function ExternalLink({ title, url }: { title: string; url: string }) {
  return <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => undefined)}><Text style={styles.link}>{title}</Text></Pressable>;
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  field: { gap: 6 },
  fieldLabel: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  input: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background, fontSize: 14 },
  note: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  message: { color: palette.warning, fontSize: 13, lineHeight: 20 },
  resultTitle: { color: palette.ink, fontSize: 16, lineHeight: 23, fontWeight: '700' },
  verifiedCard: { backgroundColor: palette.accentSoft, borderColor: '#D8E7DC' },
  verifiedLabel: { color: palette.accent, fontSize: 12, fontWeight: '800' },
  link: { color: palette.accent, fontSize: 13, fontWeight: '700', textDecorationLine: 'underline' },
  candidate: { gap: 8, paddingTop: 10, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: palette.border },
  taskHeader: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  checkbox: { width: 26, height: 26, borderWidth: 1.5, borderColor: palette.muted, borderRadius: 7, alignItems: 'center', justifyContent: 'center' },
  checkboxSelected: { backgroundColor: palette.accent, borderColor: palette.accent },
  checkmark: { color: '#FFFFFF', fontSize: 17, fontWeight: '800' },
  taskHeading: { flex: 1, gap: 3 },
  taskIndex: { color: palette.accent, fontSize: 10, fontWeight: '800', letterSpacing: 1 },
  cycleRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, paddingVertical: 8, borderTopWidth: StyleSheet.hairlineWidth, borderBottomWidth: StyleSheet.hairlineWidth, borderColor: palette.border },
  flexCopy: { flex: 1, gap: 3 },
  cycleInputWrap: { flexDirection: 'row', alignItems: 'center', gap: 7, borderRadius: 10, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 9, backgroundColor: palette.background },
  cycleInput: { minWidth: 54, paddingVertical: 7, color: palette.ink, textAlign: 'center', fontWeight: '700' },
  cautionBox: { backgroundColor: palette.warningSoft, borderRadius: 12, padding: 12, gap: 4 },
  cautionTitle: { color: palette.warning, fontSize: 13, fontWeight: '800' },
  cautionText: { color: palette.warning, fontSize: 12, lineHeight: 19 },
});
