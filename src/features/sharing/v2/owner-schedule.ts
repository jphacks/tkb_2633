import type { V2GroupScreenModel } from './controller';
import type { V2PersonalPlan } from './personal-plan';

/** One owner filter for reminders and private daily-load checks. It never reads Calendar or moves a task. */
export function v2OwnedPendingSchedule(model: V2GroupScreenModel, userId: string, personal?: V2PersonalPlan, purpose: 'reminder' | 'load' = 'reminder') {
  const { plan } = model;
  if (model.viewerUserId !== userId || !plan.members.some(member => member.userId === userId && member.active)) throw new Error('本人の共有家事を確認してください。');
  if (personal && (personal.viewerUserId !== userId || personal.groupId !== plan.groupId || personal.commonPlanHash !== plan.planHash)) throw new Error('本人の推奨日を読み直してください。');
  const chores = new Map(plan.chores.map(chore => [chore.id, chore]));
  const suggestions = new Map(personal?.recommendations.map(row => [row.subjectOccurrenceId, row]) ?? []);
  return plan.occurrences.flatMap(round => {
    const chore = chores.get(round.choreId);
    if (!chore || !chore.enabled || chore.archived || !round.activeInPeriod || round.assignmentConflictIds.length || round.needsAssignment) return [];
    return round.subjects.flatMap(subject => {
      const owns = subject.subjectUserId === null ? !round.assigneeIds.length || round.assigneeIds.includes(userId) : subject.subjectUserId === userId;
      if (!owns || !subject.required || subject.completed || subject.pendingCompletionIds.length || subject.cooldownSuppressed || subject.virtuallyConsumed
        || subject.requestReviewIds.length || subject.dependencyBlocked || subject.dependencyAwaitingCompletion
        || subject.formalDate.kind === 'conflict' || subject.formalDate.kind === 'review') return [];
      const recommendation = suggestions.get(subject.id);
      if (purpose === 'reminder' && recommendation && !['recommended', 'manual'].includes(recommendation.state)) return [];
      return [{ round, subject, chore, date: recommendation?.date ?? subject.suggestedDate,
        untimed: subject.formalDate.kind !== 'manual' || subject.formalDate.mode !== 'fixed' }];
    });
  });
}
