import type { LocalDate } from '../../../domain/shared/types.ts';
import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { createV2PlannerActions } from './actions.ts';
import { buildV2CommonPlan } from './common-plan.ts';

/** Injected transport keeps the screen independent of production, Emulator, and offline test workspaces. */
export function createV2GroupController(repository: ReturnType<typeof createV2EventRepository>, options: {
  makeId: () => string; now: () => Date; sync: () => Promise<unknown>;
}) {
  const actions = createV2PlannerActions(repository, options);
  return {
    actions, sync: options.sync,
    async readModel(range: { from: LocalDate; through: LocalDate; asOfDate: LocalDate }) {
      const state = await repository.readState();
      return { plan: buildV2CommonPlan(state, range), viewerUserId: repository.scope.userId, adminUserId: state.archive.at(-1)!.body.ownerUserId,
        requests: state.assessment.requestStates, pendingChanges: state.assessment.pendingOutboxIds.length,
        receiptPending: state.assessment.provisionalOperationIds.length, quarantinedChanges: state.assessment.rejected.length + state.replica.pendingOperationIds.length };
    },
  };
}
export type V2GroupController = ReturnType<typeof createV2GroupController>;
export type V2GroupScreenModel = Awaited<ReturnType<V2GroupController['readModel']>>;
