import type { V2GroupScreenModel } from '../v2/controller.ts';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan.ts';

/** Local presentation only; signed command permissions are still checked by the receiver. */
export function createV2RoundVisibility(model: V2GroupScreenModel) {
  const work = new Map(model.plan.history.map((record, index) => [record.operationId, { record, index }]));
  const viewer = model.viewerUserId; const admin = viewer === model.adminUserId;
  return (round: V2PlannedOccurrence, subject: V2SubjectPlan) => {
    const owns = subject.subjectUserId === null ? round.assigneeIds.length === 0 || round.assigneeIds.includes(viewer) : subject.subjectUserId === viewer;
    const ids = new Set([...subject.completionOperationIds, ...subject.pendingCompletionIds]);
    const relatedWork = [...ids].flatMap((id) => { const record = work.get(id); return record ? [record] : []; }).sort((a, b) => a.index - b.index).map((entry) => entry.record);
    return { admin, owns, relatedWork, showStatus: owns || admin || model.plan.policy?.showCompletionStatus === true
      || relatedWork.some((record) => record.recorderUserId === viewer || record.performerUserId === viewer) };
  };
}
