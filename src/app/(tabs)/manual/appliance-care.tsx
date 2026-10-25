import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useState } from 'react';
import { ActivityIndicator, Linking, Platform, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { AppButton, Card, Page, ScreenHeading, SectionHeading, palette } from '@/components/planner-ui';
import type { ApplianceCareAnalysisStage, ApplianceCareApiResponse, ProductAnalysisErrorResponse } from '@/features/appliance-care/api-contracts';
import { analyzeApplianceCareRequest } from '@/features/appliance-care/api-client';
import type { ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import { isOfficialApplianceUrl } from '@/features/appliance-care/official-url';
import { usePlannerData } from '@/hooks/use-planner-data';
import { loadApplianceCareReviewContext, saveReviewedApplianceCare } from '@/platform/storage/repository';
import type { ApplianceCareReviewContext } from '@/platform/storage/repository';

export default function ApplianceCareScreen() {
  const params = useLocalSearchParams<{ applianceId?: string; productName?: string; returnTo?: string }>();
  const applianceId = Array.isArray(params.applianceId) ? params.applianceId[0] : params.applianceId;
  const requestedProductName = Array.isArray(params.productName) ? params.productName[0] : params.productName;
  const returnToParam = Array.isArray(params.returnTo) ? params.returnTo[0] : params.returnTo;
  const returnTo = returnToParam === '/chores' ? '/chores' : returnToParam === '/manual' ? '/manual' : undefined;
  const { database, refresh } = usePlannerData();
  const [manufacturer, setManufacturer] = useState('');
  const [productName, setProductName] = useState(requestedProductName ?? '');
  const [modelNumber, setModelNumber] = useState('');
  const [category, setCategory] = useState('');
  const [result, setResult] = useState<ApplianceCareApiResponse | null>(null);
  const [selectedIndices, setSelectedIndices] = useState<number[]>([]);
  const [cycleValues, setCycleValues] = useState<Record<number, string>>({});
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [stage, setStage] = useState<ApplianceCareAnalysisStage>('product_verification');
  const [savedContext, setSavedContext] = useState<ApplianceCareReviewContext | null>(null);
  const loadingAppliance = Boolean(applianceId) && !savedContext && !message;

  useEffect(() => {
    if (!applianceId) return;
    let cancelled = false;
    void loadApplianceCareReviewContext(database, applianceId).then((context) => {
      if (cancelled) return;
      setSavedContext(context);
      if (!context) {
        setMessage('登録した家電を読み込めませんでした。家事一覧からもう一度開いてください。');
        return;
      }
      setManufacturer(context.appliance.manufacturer);
      setProductName(context.appliance.productName);
      setModelNumber(context.appliance.modelNumber);
      setCategory(context.appliance.category ?? '');
    }).catch(() => {
      if (!cancelled) setMessage('登録した家電を読み込めませんでした。');
    });
    return () => { cancelled = true; };
  }, [applianceId, database]);

  const verified = result?.status === 'verified' ? result : undefined;

  const analyze = async () => {
    if (Platform.OS === 'web') {
      setMessage('Web版ではAIと通信しません。入力した製品情報は送信されていません。メーカー公式サイトから手動で確認してください。');
      return;
    }
    const request = { manufacturer, productName, modelNumber, category, ...(savedContext ? { forceReanalysis: true } : {}) };
    if (!request.modelNumber.trim()) {
      setMessage('型番を確認してください。型番を確認してから解析できます。');
      return;
    }
    if ([request.manufacturer, request.productName].some((value) => !value.trim())) {
      setMessage('メーカー名・製品名を入力してください。');
      return;
    }
    setWorking(true);
    setMessage(null);
    setResult(null);
    setSelectedIndices([]);
    setStage('product_verification');
    try {
      const nextResult = await analyzeApplianceCareRequest(request, undefined, undefined, setStage);
      setResult(nextResult);
      if (nextResult.status === 'verified') {
        const matched = nextResult.analysis.tasks.flatMap((task, index) => {
          const oldChore = savedContext?.chores.find((chore) => (chore.applianceTaskName ?? chore.name) === task.name);
          return oldChore ? [index] : [];
        });
        setSelectedIndices(matched);
        setCycleValues(Object.fromEntries(nextResult.analysis.tasks.map((task, index) => {
          const oldChore = savedContext?.chores.find((chore) => (chore.applianceTaskName ?? chore.name) === task.name);
          const userCycle = oldChore?.userIntervalDays ?? oldChore?.recommendedCycleDays;
          return [index, userCycle === undefined ? '' : String(userCycle)];
        })));
      }
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '解析に失敗しました。');
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
        ...(entered ? { userIntervalDays: Number(entered) } : {}),
      };
    });
    if (approvedTasks.some(({ userIntervalDays }) => userIntervalDays !== undefined
      && (!Number.isInteger(userIntervalDays) || userIntervalDays < 1 || userIntervalDays > 3650))) {
      setMessage('周期は1〜3650日の整数で入力してください。');
      return;
    }

    setWorking(true);
    setMessage(null);
    try {
      const saved = await saveReviewedApplianceCare(database, {
        ...(savedContext ? { applianceId: savedContext.appliance.id } : {}),
        manufacturer: verified.product.manufacturer,
        productName: verified.product.productName,
        modelNumber: verified.product.modelNumber,
        category: verified.product.category ?? category,
        officialProductUrl: verified.officialSources.productUrl,
        manualUrl: verified.officialSources.manualUrl,
      }, verified.analysis, approvedTasks);
      await refresh();
      setMessage(`${saved.scheduledTaskCount}件を予定へ登録しました。${saved.noCycleTaskCount ? ` 周期なしの項目${saved.noCycleTaskCount}件は家電詳細に保存しました。` : ''}${saved.duplicateTaskCount ? ` 同名の家事${saved.duplicateTaskCount}件は重複登録しませんでした。` : ''}`);
      router.replace({ pathname: '/manual/appliances/[id]', params: { id: saved.applianceId, ...(returnTo ? { returnTo } : {}) } });
    } catch (cause) {
      setMessage(cause instanceof Error ? cause.message : '家電情報を保存できませんでした。');
    } finally {
      setWorking(false);
    }
  };

  return (
    <Page>
      <Pressable accessibilityRole="button" onPress={() => returnTo ? router.replace(returnTo) : router.back()}><Text style={styles.back}>‹  {returnTo === '/chores' ? '家事一覧' : '家電一覧'}</Text></Pressable>
      <ScreenHeading
        eyebrow="OFFICIAL MANUAL"
        title={applianceId ? '公式資料を再解析' : '家電を追加'}
        description="メーカー名・製品名・型番から公式製品と取扱説明書を確認します。内容を確認してから家事に追加できます。"
      />

      <Card>
        <SectionHeading title="製品情報" />
        <Field label="メーカー名" value={manufacturer} onChangeText={setManufacturer} placeholder="例：Dyson" editable={!savedContext} />
        <Field label="製品名" value={productName} onChangeText={setProductName} placeholder="例：V12 Detect Slim" editable={!savedContext} />
        <Field label="型番" value={modelNumber} onChangeText={(value) => { setModelNumber(value); setMessage(null); }} placeholder="例：SV20" editable={!savedContext} />
        {getOfficialSupportUrl(manufacturer) ? <ExternalLink title="メーカー公式サイトで型番を確認する ↗" url={getOfficialSupportUrl(manufacturer)!} manufacturer={manufacturer} /> : null}
        <Field label="カテゴリ（任意）" value={category} onChangeText={setCategory} placeholder="例：vacuum_cleaner" editable={!savedContext} />
        {savedContext ? <Text style={styles.note}>再解析では家電の識別情報を固定します。別の製品は家事一覧から新しく登録してください。</Text> : null}
        <Text style={styles.note}>{Platform.OS === 'web'
          ? 'Web版ではAIとの通信を行いません。入力した製品情報は送信されません。AI向けのプロンプトはリポジトリ内に残しています。'
          : '検索を実行すると入力した製品情報と公式資料が外部サービスへ送られます。APIキーはアプリに保存せず、接続先サーバーだけで使用します。'}</Text>
        <AppButton
          title={Platform.OS === 'web' ? 'Web版ではAI解析を利用できません' : loadingAppliance ? '家電を読み込んでいます…' : working ? '解析しています…' : savedContext ? '公式資料を再解析' : '公式資料を検索して解析'}
          onPress={() => void analyze()}
          disabled={Platform.OS === 'web' || working || loadingAppliance || (Boolean(applianceId) && !savedContext)}
        />
      </Card>

      {working ? (
        <Card style={styles.progressCard}>
          <ActivityIndicator color={palette.accent} />
          <View style={styles.progressCopy}>
            <Text style={styles.resultTitle}>{stage === 'product_verification' ? '製品を確認しています' : '公式説明書を解析しています'}</Text>
            <Text style={styles.note}>完了率は表示せず、処理段階だけを表示します。</Text>
          </View>
        </Card>
      ) : null}

      {message ? <Card><Text style={message.includes('件を予定へ登録') ? styles.savedMessage : styles.message}>{message}</Text></Card> : null}
      {result?.status === 'not_found' ? (
        <Card><Text style={styles.resultTitle}>製品不明</Text><Text style={styles.body}>{result.message}</Text></Card>
      ) : null}
      {result?.status === 'error' ? (
        <Card><Text style={styles.resultTitle}>{errorTitle(result)}</Text><Text style={styles.body}>{result.message}</Text></Card>
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
              <ExternalLink title="公式製品情報を開く ↗" url={candidate.officialProductUrl} manufacturer={candidate.manufacturer} />
            </View>
          ))}
        </Card>
      ) : null}

      {verified ? (
        <>
          <Card style={styles.verifiedCard}>
            <Text style={styles.verifiedLabel}>メーカー公式情報で確認済み</Text>
            <Text style={styles.resultTitle}>{verified.product.manufacturer} {verified.product.productName}（{verified.product.modelNumber}）</Text>
            {verified.officialSources.productUrl ? <ExternalLink title="公式製品情報を開く ↗" url={verified.officialSources.productUrl} manufacturer={verified.product.manufacturer} /> : null}
            <ExternalLink title="公式取扱説明書を開く ↗" url={verified.officialSources.manualUrl} manufacturer={verified.product.manufacturer} />
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
              manufacturer={verified.product.manufacturer}
            />
          ))}
          <AppButton title={working ? '保存中…' : selectedIndices.length ? `選択した${selectedIndices.length}件を予定へ登録して保存` : '家電と解析結果を保存'} onPress={() => void addSelected()} disabled={working} />
          <Text style={styles.note}>具体的なメーカー周期がない項目は周期なしのまま家電詳細に保存し、自動予定には追加しません。周期を入力した項目だけ予定に登録します。</Text>
        </>
      ) : null}
    </Page>
  );
}

function Field({ label, value, onChangeText, placeholder, editable = true }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  editable?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput editable={editable} value={value} onChangeText={onChangeText} placeholder={placeholder} placeholderTextColor={palette.muted} style={[styles.input, !editable && styles.inputReadonly]} maxLength={120} autoCapitalize="words" />
    </View>
  );
}

function TaskReviewCard({ task, index, selected, cycleValue, onToggle, onChangeCycle, manufacturer }: {
  task: ApplianceCareTaskDraft;
  index: number;
  selected: boolean;
  cycleValue: string;
  onToggle: () => void;
  onChangeCycle: (value: string) => void;
  manufacturer: string;
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
            ? <Text style={styles.body}>メーカー推奨：{task.recommendedIntervalDays}日</Text>
            : <Text style={styles.noCycleTag}>定期予定なし · メーカー指定の具体的周期なし</Text>}
        </View>
        <View style={styles.cycleInputWrap}>
          <TextInput value={cycleValue} onChangeText={onChangeCycle} keyboardType="number-pad" style={styles.cycleInput} accessibilityLabel={`${task.name}の周期`} placeholder="任意" />
          <Text style={styles.fieldLabel}>日</Text>
        </View>
      </View>
      {task.recommendedIntervalDays === undefined ? <Text style={styles.note}>周期欄を空のままにすると家電詳細に保存され、カレンダー・自動予定・定期通知には入りません。周期を入力すると、その設定で予定を作ります。</Text> : null}
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
        <ExternalLink key={`${item.url}-${evidenceIndex}`} title={`出典を見る${item.pageOrSection ? ` · ${item.pageOrSection}` : ''} ↗`} url={item.url} manufacturer={manufacturer} />
      ))}
    </Card>
  );
}

function ExternalLink({ title, url, manufacturer }: { title: string; url: string; manufacturer: string }) {
  if (!isOfficialApplianceUrl(url, manufacturer)) return <Text style={styles.invalidLink}>公式URLを検証できないため開けません。</Text>;
  return <Pressable accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => undefined)}><Text style={styles.link}>{title}</Text></Pressable>;
}

function getOfficialSupportUrl(manufacturer: string): string | undefined {
  const normalized = manufacturer.normalize('NFKC').trim().toLocaleLowerCase('en-US');
  const urls: Record<string, string> = {
    dyson: 'https://www.dyson.co.jp/support', ダイソン: 'https://www.dyson.co.jp/support',
    panasonic: 'https://panasonic.jp/support/', パナソニック: 'https://panasonic.jp/support/',
    hitachi: 'https://kadenfan.hitachi.co.jp/support/', 日立: 'https://kadenfan.hitachi.co.jp/support/',
    sharp: 'https://jp.sharp/support/', シャープ: 'https://jp.sharp/support/',
  };
  return urls[normalized];
}

function errorTitle(error: ProductAnalysisErrorResponse): string {
  if (error.code === 'WEB_AI_DISABLED') return 'Web版では利用できません';
  if (error.code === 'MANUAL_NOT_FOUND') return '説明書なし';
  if (error.code === 'ANALYSIS_FAILED' || error.code === 'AI_ANALYSIS_FAILED' || error.code === 'INVALID_AI_OUTPUT') return '解析失敗';
  if (error.code === 'PRODUCT_NOT_FOUND') return '製品不明';
  return '一時的な通信失敗';
}

const styles = StyleSheet.create({
  back: { color: palette.accent, fontSize: 14, fontWeight: '700', paddingVertical: 3 },
  field: { gap: 6 },
  fieldLabel: { color: palette.ink, fontSize: 13, fontWeight: '700' },
  input: { minHeight: 46, borderRadius: 12, borderWidth: 1, borderColor: palette.border, paddingHorizontal: 12, color: palette.ink, backgroundColor: palette.background, fontSize: 14 },
  inputReadonly: { opacity: 0.7 },
  note: { color: palette.muted, fontSize: 11, lineHeight: 17 },
  body: { color: palette.muted, fontSize: 13, lineHeight: 20 },
  message: { color: palette.warning, fontSize: 13, lineHeight: 20 },
  savedMessage: { color: palette.accent, fontSize: 13, lineHeight: 20, fontWeight: '600' },
  resultTitle: { color: palette.ink, fontSize: 16, lineHeight: 23, fontWeight: '700' },
  verifiedCard: { backgroundColor: palette.accentSoft, borderColor: '#D8E7DC' },
  progressCard: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  progressCopy: { flex: 1, gap: 4 },
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
  noCycleTag: { color: '#8D682E', fontSize: 12, lineHeight: 18, fontWeight: '800' },
  invalidLink: { color: palette.muted, fontSize: 11 },
  cautionBox: { backgroundColor: palette.warningSoft, borderRadius: 12, padding: 12, gap: 4 },
  cautionTitle: { color: palette.warning, fontSize: 13, fontWeight: '800' },
  cautionText: { color: palette.warning, fontSize: 12, lineHeight: 19 },
});
