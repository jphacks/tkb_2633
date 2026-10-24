import type { ApplianceCareAnalysisDraft, ApplianceCareTaskDraft } from './contracts';
import type { ChoreDefinition } from '../../domain/chores/types';
import type { EntityId } from '../../domain/shared/types';
import type { ApprovedApplianceCareTask, ApplianceCareProductIdentity } from './to-chore-definition';
import { toApplianceCareChore } from './to-chore-definition.ts';

export function effectiveApplianceIntervalDays(
  manufacturerIntervalDays?: number,
  userIntervalDays?: number,
): number | undefined {
  return userIntervalDays ?? manufacturerIntervalDays;
}

export function shouldScheduleApplianceCareTask(
  task: ApplianceCareTaskDraft,
  userIntervalDays?: number,
): boolean {
  return effectiveApplianceIntervalDays(task.recommendedIntervalDays, userIntervalDays) !== undefined;
}

export function hasExactChoreNameDuplicate(
  existingChores: readonly Pick<ChoreDefinition, 'id' | 'name'>[],
  proposedName: string,
  exceptChoreId?: EntityId,
): boolean {
  return existingChores.some((chore) => chore.id !== exceptChoreId && chore.name === proposedName);
}

export function buildReviewedApplianceChore(options: {
  id: EntityId;
  householdId: EntityId;
  applianceId: EntityId;
  product: Omit<ApplianceCareProductIdentity, 'applianceId'>;
  analysis: ApplianceCareAnalysisDraft;
  approved: ApprovedApplianceCareTask;
  existing?: ChoreDefinition;
}): { definition: ChoreDefinition; hasCycle: boolean } {
  const existing = options.existing;
  const userIntervalDays = options.approved.userIntervalDays
    ?? existing?.userIntervalDays
    ?? existing?.recommendedCycleDays;
  const definition = toApplianceCareChore(
    options.id,
    options.householdId,
    { ...options.product, applianceId: options.applianceId },
    options.analysis,
    { task: options.approved.task, ...(userIntervalDays !== undefined ? { userIntervalDays } : {}) },
  );
  const hasCycle = shouldScheduleApplianceCareTask(options.approved.task, definition.userIntervalDays);
  if (!existing) return { definition, hasCycle };

  return {
    hasCycle,
    definition: {
      ...definition,
      enabled: hasCycle && existing.enabled,
      load: existing.load,
      windowRadiusDays: existing.windowRadiusDays,
      maxShiftDays: existing.maxShiftDays,
      holidayPriority: existing.holidayPriority,
      ...(!hasCycle ? { requiresCycleSelection: true } : {}),
    },
  };
}

export function retireApplianceTaskSnapshot(chore: ChoreDefinition): ChoreDefinition {
  const { applianceCareSource: _previousSource, ...userDataAndDefinition } = chore;
  return {
    ...userDataAndDefinition,
    enabled: false,
    description: 'この項目は最新のメーカー公式解析結果に含まれていません。過去の実施履歴は保持しています。',
    instructions: [],
    tools: [],
    cautions: [],
    manufacturerRecommendedIntervalDays: undefined,
    manufacturerRecommendedConditions: undefined,
    estimatedMinutes: undefined,
  };
}
