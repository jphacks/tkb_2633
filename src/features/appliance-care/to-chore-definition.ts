import type { ApplianceCareAnalysisDraft, ApplianceCareTaskDraft } from '@/features/appliance-care/contracts';
import type { ChoreDefinition } from '@/domain/chores/types';
import type { EntityId } from '@/domain/shared/types';

export interface ApplianceCareProductIdentity {
  manufacturer: string;
  productName: string;
  modelNumber: string;
  manualUrl: string;
}

export interface ApprovedApplianceCareTask {
  task: ApplianceCareTaskDraft;
  userCycleDays?: number;
}

export function toApplianceCareChore(
  id: EntityId,
  householdId: EntityId,
  product: ApplianceCareProductIdentity,
  analysis: ApplianceCareAnalysisDraft,
  approved: ApprovedApplianceCareTask,
): ChoreDefinition {
  const manufacturerCycle = approved.task.recommendedIntervalDays;
  const userCycle = approved.userCycleDays;
  if (userCycle !== undefined && (!Number.isInteger(userCycle) || userCycle < 1 || userCycle > 3650)) {
    throw new RangeError('周期は1〜3650日の整数で入力してください。');
  }
  const cycleRequired = userCycle === undefined && manufacturerCycle === undefined;
  const fallbackCycle = manufacturerCycle ?? 30;
  const selectedUserCycle = userCycle !== undefined && userCycle !== manufacturerCycle ? userCycle : undefined;

  return {
    id,
    householdId,
    name: approved.task.name,
    category: '家電',
    description: product.manufacturer + ' ' + product.productName + '（' + product.modelNumber + '）のお手入れ作業です。',
    enabled: !cycleRequired,
    ...(selectedUserCycle !== undefined ? { recommendedCycleDays: selectedUserCycle } : {}),
    ...(manufacturerCycle !== undefined ? { manufacturerRecommendedIntervalDays: manufacturerCycle } : {}),
    ...((approved.task.recommendedConditions ?? []).length > 0
      ? { manufacturerRecommendedConditions: [...(approved.task.recommendedConditions ?? [])] }
      : {}),
    ...(cycleRequired ? { requiresCycleSelection: true } : {}),
    frequencyDaysByMode: { frequent: fallbackCycle, balanced: fallbackCycle, relaxed: fallbackCycle },
    windowRadiusDays: 1,
    maxShiftDays: 7,
    load: 'light',
    holidayPriority: false,
    everyday: false,
    locationOrAppliance: product.productName + '（' + product.modelNumber + '）',
    instructions: [...approved.task.steps],
    tools: [...approved.task.tools],
    cautions: [...approved.task.safetyCautions],
    ...(approved.task.estimatedMinutes !== undefined ? { estimatedMinutes: approved.task.estimatedMinutes } : {}),
    applianceCareSource: {
      manufacturer: product.manufacturer,
      productName: product.productName,
      modelNumber: product.modelNumber,
      manualUrl: product.manualUrl,
      analyzedAt: analysis.analyzedAt,
      evidence: approved.task.evidence.map((item) => ({ ...item })),
    },
  };
}
