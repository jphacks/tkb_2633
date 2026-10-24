import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildReviewedApplianceChore,
  effectiveApplianceIntervalDays,
  hasExactChoreNameDuplicate,
  retireApplianceTaskSnapshot,
  shouldScheduleApplianceCareTask,
} from '../src/features/appliance-care/persistence-policy.ts';
import { isOfficialApplianceUrl } from '../src/features/appliance-care/official-url.ts';

const product = {
  applianceId: 'appliance-a',
  manufacturer: 'Dyson',
  productName: 'V12 Detect Slim',
  modelNumber: 'SV20',
  category: '掃除機',
  officialProductUrl: 'https://www.dyson.co.jp/support/vacuum-cleaners/cordless/v12-detect-slim',
  manualUrl: 'https://www.dyson.co.jp/content/dam/dyson/maintenance/user-guides/ja_JP/Vacuumcleaners/cordlessstickvacuums/v12/manual.pdf',
};

function task(name, interval, evidenceUrl = product.manualUrl) {
  return {
    name,
    ...(interval !== undefined ? { recommendedIntervalDays: interval } : {}),
    recommendedConditions: interval === undefined ? ['汚れが気になったとき'] : [],
    steps: ['手順を確認する'],
    tools: ['やわらかい布'],
    safetyCautions: ['電源を切る'],
    evidence: [{ url: evidenceUrl, pageOrSection: 'p. 12' }],
  };
}

function analysis(tasks, analyzedAt = '2026-10-24T00:00:00.000Z') {
  return { manufacturer: 'Dyson', model: 'SV20', tasks, analyzedAt, requiresUserReview: true };
}

test('maker interval and user override remain separate and use nullish override semantics', () => {
  assert.equal(effectiveApplianceIntervalDays(30, undefined), 30);
  assert.equal(effectiveApplianceIntervalDays(30, 60), 60);
  assert.equal(effectiveApplianceIntervalDays(30, 30), 30);
  assert.equal(effectiveApplianceIntervalDays(undefined, undefined), undefined);
});

test('tasks without manufacturer cycles are not scheduled unless a user explicitly sets a cycle', () => {
  const noCycleTask = task('クリアビンを確認する', undefined);
  assert.equal(shouldScheduleApplianceCareTask(noCycleTask), false);
  assert.equal(shouldScheduleApplianceCareTask(noCycleTask, 45), true);

  const saved = buildReviewedApplianceChore({
    id: 'care-no-cycle', householdId: 'local-household', applianceId: product.applianceId,
    product, analysis: analysis([noCycleTask]), approved: { task: noCycleTask },
  });
  assert.equal(saved.hasCycle, false);
  assert.equal(saved.definition.enabled, false);
  assert.equal(saved.definition.requiresCycleSelection, true);
  assert.equal(saved.definition.applianceId, product.applianceId);
  assert.equal(saved.definition.applianceCareSource.evidence[0].pageOrSection, 'p. 12');
});

test('reanalysis replaces manufacturer evidence while retaining exact-task user settings and chore identity', () => {
  const oldTask = task('フィルターを洗う', 30);
  const existing = {
    id: 'care-filter', householdId: 'local-household', name: '掃除機のフィルターを洗う', category: '家電',
    description: 'old', enabled: false, recommendedCycleDays: 60, userIntervalDays: 60,
    manufacturerRecommendedIntervalDays: 30, frequencyDaysByMode: { frequent: 30, balanced: 30, relaxed: 30 },
    windowRadiusDays: 3, maxShiftDays: 9, load: 'heavy', holidayPriority: true, everyday: false,
    instructions: ['old step'], tools: [], cautions: [], applianceId: product.applianceId,
    applianceTaskName: oldTask.name,
  };
  const newTask = task('フィルターを洗う', 45);
  const nextAnalysis = analysis([newTask], '2026-10-25T00:00:00.000Z');
  const result = buildReviewedApplianceChore({
    id: existing.id, householdId: existing.householdId, applianceId: product.applianceId,
    product, analysis: nextAnalysis, approved: { task: newTask }, existing,
  });

  assert.equal(result.definition.id, existing.id);
  assert.equal(result.definition.userIntervalDays, 60);
  assert.equal(result.definition.manufacturerRecommendedIntervalDays, 45);
  assert.deepEqual(result.definition.instructions, ['手順を確認する']);
  assert.equal(result.definition.applianceCareSource.analyzedAt, nextAnalysis.analyzedAt);
  assert.equal(result.definition.applianceCareSource.evidence[0].pageOrSection, 'p. 12');
  assert.equal(result.definition.enabled, false);
  assert.equal(result.definition.load, 'heavy');
  assert.equal(result.definition.windowRadiusDays, 3);
  assert.equal(result.definition.holidayPriority, true);
});

test('choosing the maker interval removes a prior override', () => {
  const oldTask = task('フィルターを洗う', 30);
  const existing = {
    id: 'care-filter', householdId: 'local-household', name: '掃除機のフィルターを洗う', category: '家電',
    description: 'old', enabled: true, recommendedCycleDays: 60, userIntervalDays: 60,
    manufacturerRecommendedIntervalDays: 30, frequencyDaysByMode: { frequent: 60, balanced: 60, relaxed: 60 },
    windowRadiusDays: 1, maxShiftDays: 7, load: 'light', holidayPriority: false, everyday: false,
    instructions: [], tools: [], cautions: [], applianceId: product.applianceId, applianceTaskName: oldTask.name,
  };
  const result = buildReviewedApplianceChore({
    id: existing.id, householdId: existing.householdId, applianceId: product.applianceId,
    product, analysis: analysis([oldTask]), approved: { task: oldTask, userIntervalDays: 30 }, existing,
  });
  assert.equal(result.definition.userIntervalDays, undefined);
  assert.equal(result.definition.recommendedCycleDays, undefined);
  assert.equal(effectiveApplianceIntervalDays(result.definition.manufacturerRecommendedIntervalDays, result.definition.userIntervalDays), 30);
});

test('tasks removed by reanalysis retire manufacturer details while retaining the user interval', () => {
  const oldTask = task('昔のメンテナンス', 30);
  const saved = buildReviewedApplianceChore({
    id: 'care-retired', householdId: 'local-household', applianceId: product.applianceId,
    product, analysis: analysis([oldTask]), approved: { task: oldTask, userIntervalDays: 60 },
  }).definition;
  const retired = retireApplianceTaskSnapshot(saved);
  assert.equal(retired.enabled, false);
  assert.equal(retired.userIntervalDays, 60);
  assert.equal(retired.applianceCareSource, undefined);
  assert.deepEqual(retired.instructions, []);
  assert.match(retired.description, /過去の実施履歴は保持/u);
});

test('deduplication matches only the exact chore name', () => {
  const chores = [{ id: 'a', name: '掃除機のフィルターを洗う' }];
  assert.equal(hasExactChoreNameDuplicate(chores, '掃除機のフィルターを洗う'), true);
  assert.equal(hasExactChoreNameDuplicate(chores, 'フィルターを洗う'), false);
});

test('official links require HTTPS and a configured manufacturer host', () => {
  assert.equal(isOfficialApplianceUrl('https://support.dyson.co.jp/manual', 'Dyson'), true);
  assert.equal(isOfficialApplianceUrl('http://www.dyson.co.jp/manual', 'Dyson'), false);
  assert.equal(isOfficialApplianceUrl('https://dyson.co.jp.attacker.invalid/manual', 'Dyson'), false);
  assert.equal(isOfficialApplianceUrl('https://example.com/manual', 'Dyson'), false);
});
