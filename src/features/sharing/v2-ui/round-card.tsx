import { StyleSheet, Text, View } from 'react-native';
import { AppButton, palette, typography } from '@/components/planner-ui';
import { TaskCheckboxRow } from '@/components/task-checkbox-row';
import { formatJapaneseDate } from '@/domain/scheduling/local-date';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2RoundReference } from '../v2/actions';
import type { V2Recommendation } from '../v2/personal-plan';
import { v2TargetLabel } from './target-form';

export function V2RoundCard({ model, round, subject, actions, busy, run, onOpen, onDate, onAssignment, onPast, onAssignmentRequest, showActions = false, recommendation }: {
  model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; onOpen: () => void; onDate: () => void; onAssignment: () => void;
  onPast: () => void; onAssignmentRequest?: () => void; showActions?: boolean;
  recommendation?: V2Recommendation;
}) {
  const chore = model.plan.chores.find((entry) => entry.id === round.choreId); if (!chore) return null;
  const viewer = model.viewerUserId; const admin = viewer === model.adminUserId;
  const nameOf = (uid: string) => model.plan.members.find((member) => member.userId === uid)?.displayName ?? '以前のメンバー';
  const owns = subject.subjectUserId === null ? round.assigneeIds.length === 0 || round.assigneeIds.includes(viewer) : subject.subjectUserId === viewer;
  const relatedWork = model.plan.history.filter((record) => [...subject.completionOperationIds, ...subject.pendingCompletionIds].includes(record.operationId));
  const showStatus = owns || admin || relatedWork.some((record) => record.recorderUserId === viewer || record.performerUserId === viewer) || model.plan.policy?.showCompletionStatus === true;
  const undo = subject.completionOperationIds.filter((id) => model.plan.history.some((record) => record.operationId === id && record.active && (admin || record.recorderUserId === viewer)));
  const ref: V2RoundReference = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId };
  const canComplete = owns && round.activeInPeriod && !subject.pendingCompletionIds.length && !subject.dependencyBlocked && !subject.dependencyAwaitingCompletion && !round.assignmentConflictIds.length;
  const onToggle = busy ? undefined : subject.completed ? undo.length ? () => run(() => actions.undoMany(undo)) : undefined
    : canComplete ? () => run(() => actions.complete(ref, { expectedAssigneeIds: subject.subjectUserId === null ? round.assigneeIds : [subject.subjectUserId] })) : undefined;
  const category = subject.subjectUserId ? `各人が実施 · ${nameOf(subject.subjectUserId)}` : round.assigneeIds.length
    ? `${round.claimState === 'provisional' ? '暫定担当' : '担当'}：${round.assigneeIds.map(nameOf).join('・')}` : '全員共通 · 担当未確定';
  const formal = subject.formalDate;
  const schedules = relatedWork.filter((record) => record.active && record.schedule).map((record) => record.schedule!);
  const recordedWindow = subject.completed && schedules.length && schedules.every((schedule) => schedule.windowStart === schedules[0].windowStart && schedule.windowEnd === schedules[0].windowEnd) ? schedules[0] : null;
  const assignmentPending = model.assignmentRequests.some((request) => !request.cancelled && request.proposal.occurrenceId === round.id && request.proposal.requesterUserId === viewer
    && ['pendingDelivery', 'awaiting'].includes(request.kind));
  return <View style={styles.card}>
    <TaskCheckboxRow chore={{ ...chore, householdId: '', category }} completed={showStatus && subject.completed} deemphasized={subject.cooldownSuppressed || subject.virtuallyConsumed} onOpen={onOpen} onToggle={onToggle} />
    <View style={styles.details}>
      <Text style={styles.date}>{formal.kind === 'manual' ? `${formal.mode === 'fixed' ? '固定日時' : formal.mode === 'deadline' ? '期限' : '実施日'}：${v2TargetLabel(formal.target, model.plan.timeZone)}`
        : `${recommendation ? '推奨日' : '基準日'}：${formatJapaneseDate(recommendation?.date ?? subject.suggestedDate, { weekday: true })}`}</Text>
      {showActions && (!subject.completed || recordedWindow) ? <Text style={styles.caption}>{subject.completed ? '実施時点の期間' : '実施できる期間'}：
        {formatJapaneseDate(recordedWindow?.windowStart ?? subject.executionWindowStart)}〜{formatJapaneseDate(recordedWindow?.windowEnd ?? subject.executionWindowEnd)}</Text> : null}
      {round.claimState === 'provisional' ? <Text style={styles.notice}>引き受けが重なっています。暫定担当のまま実施でき、管理者が正式な担当を決めます。</Text> : null}
      {round.assignmentConflictIds.length ? <Text style={styles.notice}>{round.assignmentMappingReviewIds.length
        ? '周期の変更に合わせて、以前の担当指定をどう適用するか確認してください。' : '担当が競合しています。管理者による確認が必要です。'}</Text> : null}
      {formal.kind === 'conflict' || formal.kind === 'review' || subject.requestReviewIds.length ? <Text style={styles.notice}>日時の確認が必要です。実施した記録は保持されます。</Text> : null}
      {subject.dependencyAwaitingCompletion ? <Text style={styles.notice}>先に必要な家事の完了を待っています。</Text> : null}
      {subject.cooldownSuppressed ? <Text style={styles.caption}>最近実施済み · {subject.minimumNextExecutionDay ? formatJapaneseDate(subject.minimumNextExecutionDay) : ''}以降に再実施できます。</Text> : null}
      {subject.virtuallyConsumed && !subject.completed ? <Text style={styles.caption}>この回は未完了のまま残り、次の周期へ進みます。</Text> : null}
      {showStatus && subject.pendingCompletionIds.length ? <Text style={styles.notice}>実施記録の確認・承認待ち</Text> : null}
      {showStatus && subject.strictInstructionUnfulfilled ? <Text style={styles.notice}>実施済み · 指定日時の条件は未達成です。</Text> : null}
      {showStatus && subject.completed ? <Text style={styles.caption}>実施者：{[...new Set(relatedWork.filter((record) => record.active).map((record) => nameOf(record.performerUserId)))].join('・')}</Text> : null}
      {showStatus && subject.completed && undo.length < subject.completionOperationIds.length ? <Text style={styles.caption}>ほかの人が登録した完了は、その登録者か管理者が取り消せます。</Text> : null}
      <View style={styles.buttons}>
        {showActions ? <AppButton title="日時を変更" compact variant="secondary" disabled={busy || !round.activeInPeriod || Boolean(round.assignmentConflictIds.length)} onPress={onDate} /> : null}
        {showActions && !subject.completed ? <AppButton title={owns ? '以前の実施を記録' : model.plan.policy?.allowSubstitution ? '代行を記録' : '代行を記録（承認が必要）'} compact variant="quiet" disabled={busy || Boolean(round.assignmentConflictIds.length)} onPress={onPast} /> : null}
        {showActions && admin ? <AppButton title={round.assignmentConflictIds.length ? '担当の競合を解決' : round.claimState === 'provisional' ? '暫定担当を確認' : '担当を変更'} compact variant="quiet" disabled={busy} onPress={onAssignment} /> : null}
        {round.configuration.policy.completion === 'one' && !round.assigneeIds.length && !subject.completed && !round.assignmentConflictIds.length
          ? <AppButton title="引き受ける" compact disabled={busy} onPress={() => run(() => actions.claim(ref))} /> : null}
        {showActions && !subject.completed && round.claimantUserIds.includes(viewer) && !round.assignmentFixed
          ? <AppButton title="引き受けを解除" compact variant="quiet" disabled={busy} onPress={() => run(() => actions.releaseClaim(ref))} /> : null}
        {showActions && round.assignmentFixed && owns && !subject.completed ? <AppButton title={assignmentPending ? '担当変更を申請中' : onAssignmentRequest ? '担当の変更を申請' : '自分の担当解除を申請'} compact variant="quiet" disabled={busy || assignmentPending}
          onPress={onAssignmentRequest ?? (() => run(() => { const remaining = round.assigneeIds.filter((uid) => uid !== viewer); return actions.requestAssignment(ref,
            { memberIds: remaining, start: 'this', scope: 'once', fixed: remaining.length > 0 && round.assignmentFixed,
              expectedAssignmentIds: round.assignmentOperationIds, expectedConflictIds: round.assignmentConflictIds }); }))} /> : null}
      </View>
    </View>
  </View>;
}
const styles = StyleSheet.create({
  card: { gap: 6 }, details: { paddingHorizontal: 12, gap: 5 },
  date: { ...typography.label, color: palette.ink, fontWeight: '600' }, caption: { ...typography.caption, color: palette.muted },
  notice: { ...typography.caption, color: palette.warning }, buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
