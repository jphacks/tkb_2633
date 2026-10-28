import type { LocalNotificationRequest } from '../../notifications/contracts';
import type { V2GroupScreenModel } from './controller';
import type { V2PersonalPlan } from './personal-plan';
import { v2NativeWorkspaceNamespace, v2NotificationPrefix } from './native-identity.ts';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { sharedDateAtTime, sharedLocalDate } from '../group-clock.ts';
import type { LocalDate } from '../../../domain/shared/types';

export interface V2ReminderPreferences { enabled: boolean; hour: number; minute: number }
export function validateV2ReminderPreferences(value: V2ReminderPreferences): V2ReminderPreferences {
  if (!value || Object.keys(value).sort().join(',') !== 'enabled,hour,minute' || typeof value.enabled !== 'boolean'
    || !Number.isInteger(value.hour) || value.hour < 0 || value.hour > 23 || !Number.isInteger(value.minute) || value.minute < 0 || value.minute > 59) throw new Error('共有家事の通知時刻を確認してください。');
  return { enabled: value.enabled, hour: value.hour, minute: value.minute };
}

/** Own reminders only. Shared completion, tentative claims and per-member subjects keep their actual identity. */
export function createV2ReminderRequests(input: { model: V2GroupScreenModel; userId: string; groupId: string;
  preferences: V2ReminderPreferences; personal?: V2PersonalPlan; now: Date }) {
  const { model, userId, groupId, now, personal } = input; const preferences = validateV2ReminderPreferences(input.preferences); const { plan } = model;
  if (model.viewerUserId !== userId || plan.groupId !== groupId || !Number.isFinite(now.getTime())
    || !plan.members.some(member => member.userId === userId && member.active)) throw new Error('通知する本人・共有グループを確認してください。');
  if (personal && (personal.viewerUserId !== userId || personal.groupId !== groupId || personal.commonPlanHash !== plan.planHash)) throw new Error('本人の推奨日を読み直してください。');
  const namespace = v2NativeWorkspaceNamespace(userId, groupId); const prefix = v2NotificationPrefix(userId, groupId);
  const today = sharedLocalDate(now, plan.timeZone); const through = addDays(today, 30);
  if (plan.range.from > today || plan.range.through < through || plan.range.asOfDate !== today) throw new Error('通知に必要な予定期間を読み直してください。');
  if (!preferences.enabled || !plan.initialized || !plan.policy) return { requests: [] as LocalNotificationRequest[], skippedDates: [] as LocalDate[] };
  const names = new Map(plan.chores.map(chore => [chore.id, chore]));
  const suggestions = new Map(personal?.recommendations.map(row => [row.subjectOccurrenceId, row]) ?? []);
  const dates = new Map<LocalDate, Map<string, string>>();
  for (const round of plan.occurrences) {
    const chore = names.get(round.choreId);
    if (!chore || !chore.enabled || chore.archived || !round.activeInPeriod || round.assignmentConflictIds.length || round.needsAssignment) continue;
    for (const subject of round.subjects) {
      const owns = subject.subjectUserId === null ? !round.assigneeIds.length || round.assigneeIds.includes(userId) : subject.subjectUserId === userId;
      if (!owns || !subject.required || subject.completed || subject.pendingCompletionIds.length || subject.cooldownSuppressed || subject.virtuallyConsumed
        || subject.requestReviewIds.length || subject.dependencyBlocked || subject.dependencyAwaitingCompletion
        || subject.formalDate.kind === 'conflict' || subject.formalDate.kind === 'review') continue;
      const recommendation = suggestions.get(subject.id);
      if (recommendation && !['recommended', 'manual'].includes(recommendation.state)) continue;
      const date = recommendation?.date ?? subject.suggestedDate;
      const manual = subject.formalDate.kind === 'manual' && subject.formalDate.mode !== 'deadline';
      const candidates = manual ? [date] : [date, subject.executionWindowEnd, addDays(subject.executionWindowEnd, 1)];
      for (const candidate of new Set(candidates)) {
        parseLocalDate(candidate);
        if (candidate < today || candidate > through) continue;
        const bucket = dates.get(candidate) ?? new Map(); bucket.set(subject.id, chore.name); dates.set(candidate, bucket);
      }
    }
  }
  const requests: LocalNotificationRequest[] = []; const skippedDates: LocalDate[] = [];
  for (const [date, rows] of [...dates].sort(([a], [b]) => a.localeCompare(b))) {
    let fireAt: Date;
    try { fireAt = sharedDateAtTime(date, preferences.hour, preferences.minute, plan.timeZone); }
    catch { skippedDates.push(date); continue; }
    if (fireAt <= now) continue;
    const values = [...rows].sort(([a], [b]) => a.localeCompare(b)).map(([, name]) => name);
    requests.push({ key: `${prefix}${date}`, title: '今日の共有家事', subtitle: `${values.length}件の未完了タスク`,
      body: `${values.slice(0, 4).join('、')}${values.length > 4 ? `、ほか${values.length - 4}件` : ''}`, fireAt: fireAt.toISOString(),
      data: { kind: 'v2-housework-digest', date, workspace: namespace } });
  }
  return { requests, skippedDates };
}
