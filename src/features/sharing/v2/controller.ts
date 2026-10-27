import type { LocalDate } from '../../../domain/shared/types.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { createV2PlannerActions } from './actions.ts';
import { buildV2CommonPlan } from './common-plan.ts';
import { v2ReadPoint } from './view-point.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';
import { observedDateRules } from './formal-rule-view.ts';
import { v2DecisionReviews } from './decision-review.ts';
import type { SharedChoreConfiguration } from './model.ts';

/** Injected transport keeps the screen independent of production, Emulator, and offline test workspaces. */
export function createV2GroupController(repository: ReturnType<typeof createV2EventRepository>, options: {
  makeId: () => string; now: () => Date; sync: () => Promise<unknown>;
}) {
  const actions = createV2PlannerActions(repository, options);
  return {
    actions, sync: options.sync,
    async readModel(range: { from: LocalDate; through: LocalDate; asOfDate: LocalDate }) {
      const state = await repository.readState();
      const plan = buildV2CommonPlan(state, range); const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
      const configurations = plan.chores.map((chore) => {
        const facts = state.assessment.view.topic('chorePolicy', chore.id); const candidates = maximalCausalFacts(facts);
        let configuration: SharedChoreConfiguration | null = null;
        try { configuration = state.assessment.view.field('chorePolicy', chore.id, 'configuration', at)?.value as unknown as SharedChoreConfiguration ?? null; } catch { /* Expose explicit candidates to the administrator. */ }
        return { choreId: chore.id, configuration, revision: facts.reduce((maximum, op) => Math.max(maximum, (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion), 0),
          earliestEffectiveFrom: facts.map((op) => { const cfg = op.payload.configuration as unknown as SharedChoreConfiguration; return cfg.effectiveFrom ?? cfg.anchorDate; }).sort().at(-1) ?? range.asOfDate,
          candidates: candidates.map((op) => ({ operationId: op.operationId, authorUserId: op.authorUserId, recordedAt: op.recordedAt!, configuration: normalizeV2Configuration(op.payload.configuration as unknown as SharedChoreConfiguration) })) };
      });
      const reviews = v2DecisionReviews(state, repository.scope.userId);
      return { plan, configurations, viewerUserId: repository.scope.userId, adminUserId: state.archive.at(-1)!.body.ownerUserId,
        requests: state.assessment.requestStates, requestReviews: reviews.date, assignmentReviews: reviews.assignment,
        dateRules: observedDateRules(state.assessment.view, at, state.assessment.approvedRules),
        assignmentRequests: state.assessment.assignmentRequests, assignmentRules: state.assessment.view.assignmentsAt(at)?.facts ?? [], pendingChanges: state.assessment.pendingOutboxIds.length,
        receiptPending: state.assessment.provisionalOperationIds.length, quarantinedChanges: state.assessment.rejected.length + state.replica.pendingOperationIds.length };
    },
  };
}
export type V2GroupController = ReturnType<typeof createV2GroupController>;
export type V2GroupScreenModel = Awaited<ReturnType<V2GroupController['readModel']>>;
