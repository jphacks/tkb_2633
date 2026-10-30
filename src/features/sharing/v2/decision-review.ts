import type { createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sharedRosterDigest } from '../roster.ts';
import type { SharedOperation } from '../operations.ts';
import type { DateTarget } from './model.ts';

type State = Awaited<ReturnType<ReturnType<typeof createV2EventRepository>['readState']>>;
export type V2DateDecision = 'approve' | 'reject' | 'counteroffer' | 'acceptCounteroffer';
export interface V2DecisionEdit { expectedDecisionIds?: readonly string[]; expectedReviewRevision?: string }
export interface V2DateDecisionEdit extends V2DecisionEdit {
  confirmRecentWork?: boolean; confirmHighLoad?: boolean;
}

const globalContextTypes = new Set(['settings', 'groupPolicy', 'chorePolicy', 'dependency', 'designation', 'designationCancel', 'assignmentRule', 'assignmentCancel',
  'claim', 'claimRelease', 'claimResolution', 'assignmentRequest', 'assignmentDecision']);

/** Index shared prerequisites once per read, rather than rehashing the whole group for every card. */
function createReviewer(state: State, viewerUserId: string) {
  const epoch = state.archive.at(-1)!; const view = state.assessment.view;
  const requests = new Map(state.assessment.requestStates.map((request) => [request.requestId, request]));
  const assignmentRequests = new Map(state.assessment.assignmentRequests.map((request) => [request.requestId, request]));
  const allRequests = [...state.assessment.requestStates, ...state.assessment.assignmentRequests];
  const choreIds = new Set(allRequests.map((request) => request.proposal.choreId));
  const scheduledChores = new Set(view.ofType('chorePolicy').map((op) => op.entityId));
  const contextIds = new Map<string, string[]>(); const globalIds: string[] = [];
  const decisions = new Map<string, SharedOperation[]>();
  for (const op of view.ready) {
    if (globalContextTypes.has(op.entityType) || op.entityType === 'completion' || op.entityType === 'completionApproval'
      || op.entityType === 'chore' && scheduledChores.has(op.entityId) && ('load' in op.payload || 'enabled' in op.payload)) globalIds.push(op.operationId);
    else for (const id of new Set([op.payload.choreId, op.entityId])) if (typeof id === 'string' && choreIds.has(id)) {
      const ids = contextIds.get(id) ?? []; ids.push(op.operationId); contextIds.set(id, ids);
    }
    if (op.entityType === 'requestDecision' || op.entityType === 'assignmentDecision') {
      const id = op.payload.requestId as string; const answers = decisions.get(id) ?? []; answers.push(op); decisions.set(id, answers);
    }
  }
  const commonRevision = sharedDocumentDigest({ roster: sharedRosterDigest(epoch), contextIds: globalIds.sort(),
    approvedDates: state.assessment.approvedRules, approvedDateCancellations: view.dateCancellationsAt(), assignmentStates: state.assessment.assignmentRequests });
  const choreRevisions = new Map([...choreIds].map((id) => [id, sharedDocumentDigest((contextIds.get(id) ?? []).sort())]));
  const active = epoch.body.members.some((member) => member.userId === viewerUserId);
  const admin = viewerUserId === epoch.body.ownerUserId;
  const answersFor = (request: typeof allRequests[number]) => {
    const audit = new Map(request.decisions.map((answer) => [answer.operationId, answer.kind]));
    return (decisions.get(request.requestId) ?? []).map((op) => ({
      operationId: op.operationId, authorUserId: op.authorUserId, recordedAt: op.recordedAt!,
      decision: op.payload.decision as V2DateDecision, target: op.payload.target as unknown as DateTarget | null ?? null,
      referenceDecisionId: op.payload.referenceDecisionId as string | null ?? null,
      allowDuringCooldown: op.payload.allowDuringCooldown === true,
      kind: audit.get(op.operationId) ?? (state.receipts.has(op.operationId) ? 'recorded' as const : 'pendingDelivery' as const),
    })).sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
  };
  const revisionFor = (request: typeof allRequests[number], answers: ReturnType<typeof answersFor>) => sharedDocumentDigest({ request, viewerUserId, answers,
    commonRevision, choreRevision: choreRevisions.get(request.proposal.choreId)! });
  return { date: (requestId: string) => {
    const request = requests.get(requestId); if (!request) throw new Error('申請を同期してください。');
    const answers = answersFor(request); const revision = revisionFor(request, answers);
    const open = ['awaiting', 'counteroffered', 'conflict'].includes(request.kind);
    const pendingAnswer = answers.some((answer) => answer.authorUserId === viewerUserId && answer.kind === 'pendingDelivery');
    return { requestId, revision, answers, pendingAnswer,
      canVote: active && open && !pendingAnswer && (request.audience.administratorVote && admin || request.audience.approvingMemberIds.includes(viewerUserId)),
      canCounteroffer: active && open && !pendingAnswer && admin,
      acceptableCounterofferIds: active && open && !pendingAnswer && request.audience.counterofferRecipientIds.includes(viewerUserId)
        ? request.counteroffers.map((offer) => offer.operationId) : [] };
  }, assignment: (requestId: string) => {
    const request = assignmentRequests.get(requestId); if (!request) throw new Error('担当変更の申請を同期してください。');
    const answers = answersFor(request); const revision = revisionFor(request, answers);
    const pendingAnswer = answers.some((answer) => answer.authorUserId === viewerUserId && answer.kind === 'pendingDelivery');
    return { requestId, revision, answers, pendingAnswer,
      canVote: active && admin && request.kind === 'awaiting' && !request.cancelled && !pendingAnswer,
      canResolve: active && admin && request.kind === 'conflict' && !request.cancelled };
  } };
}
/** Local optimistic guard only. It neither grants authority nor becomes a shared business fact. */
export function v2DateDecisionReview(state: State, requestId: string, viewerUserId: string) {
  return createReviewer(state, viewerUserId).date(requestId);
}
export function v2DateDecisionReviews(state: State, viewerUserId: string) {
  if (!state.assessment.requestStates.length) return [];
  const review = createReviewer(state, viewerUserId);
  return state.assessment.requestStates.map((request) => review.date(request.requestId));
}
export function v2AssignmentDecisionReview(state: State, requestId: string, viewerUserId: string) {
  return createReviewer(state, viewerUserId).assignment(requestId);
}
export function v2DecisionReviews(state: State, viewerUserId: string) {
  if (!state.assessment.requestStates.length && !state.assessment.assignmentRequests.length) return { date: [], assignment: [] };
  const review = createReviewer(state, viewerUserId);
  return { date: state.assessment.requestStates.map((request) => review.date(request.requestId)),
    assignment: state.assessment.assignmentRequests.map((request) => review.assignment(request.requestId)) };
}
export type V2DateDecisionReview = ReturnType<typeof v2DateDecisionReview>;
export type V2AssignmentDecisionReview = ReturnType<typeof v2AssignmentDecisionReview>;
