export const manualUrl = 'https://www.dyson.co.jp/support/SV20';
export function applianceResult(taskNames = ['フィルター清掃', '水滴を拭く']) {
  return { status: 'verified', product: { manufacturer: 'Dyson', productName: 'V12 Detect Slim', modelNumber: 'SV20', category: 'vacuum' },
    officialSources: { manualUrl },
    analysis: { manufacturer: 'Dyson', model: 'SV20', analyzedAt: '2026-10-27T01:00:00.000Z', requiresUserReview: true,
      tasks: taskNames.map((name, index) => ({ name, ...(index === 0 ? { recommendedIntervalDays: 30 } : { recommendedConditions: ['汚れが付いたとき'] }),
        steps: ['電源を切る', '公式の手順で手入れする'], tools: ['柔らかい布'], safetyCautions: ['十分に乾燥させる'], evidence: [{ url: manualUrl, pageOrSection: 'お手入れ' }] })) } };
}
