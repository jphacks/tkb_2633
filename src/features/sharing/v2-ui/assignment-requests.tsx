import { StyleSheet, Text, View } from 'react-native';
import { AppButton, Card, palette, SectionHeading, typography } from '../../../components/planner-ui';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { v2TargetLabel } from './target-form';
const labels = { pendingDelivery: '端末に保存済み · 送信待ち', awaiting: '管理者の回答待ち', expired: '期限切れ', tooLate: '申請期限を過ぎています',
  approved: '承認済み', rejected: '拒否', conflict: '回答が競合しています · 管理者による確認が必要です' };

export function V2AssignmentRequests({ model, actions, busy, run }: { model: V2GroupScreenModel; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void> }) {
  const admin = model.viewerUserId === model.adminUserId;
  const nameOf = (uid: string) => model.plan.members.find((member) => member.userId === uid)?.displayName ?? '以前のメンバー';
  return <View style={styles.list}>{model.assignmentRequests.filter((request) => admin || request.proposal.requesterUserId === model.viewerUserId).map((request) => {
    const chore = model.plan.chores.find((entry) => entry.id === request.proposal.choreId);
    const answerPending = request.decisions.some((decision) => decision.kind === 'pendingDelivery');
    return <Card key={request.requestId}><SectionHeading title={chore?.name ?? '家事の担当変更'} />
      <Text style={styles.body}>{v2TargetLabel({ precision: 'date', date: request.proposal.anchorDate }, model.plan.timeZone)}{request.proposal.scope === 'from' ? 'から' : 'の回だけ'}</Text>
      <Text style={styles.body}>申請する担当：{request.proposal.memberIds.length ? request.proposal.memberIds.map(nameOf).join('・') : '担当なし'}</Text>
      <Text style={styles.caption}>{labels[request.kind]}{request.cancelled ? ' · 担当指定は解除済み' : answerPending ? ' · 回答の送信待ち' : ''}</Text>
      {request.kind === 'pendingDelivery' || request.kind === 'awaiting' ? <Text style={styles.caption}>正式な担当は承認の受付確認まで変わりません。</Text> : null}
      {request.deadline.kind === 'open' ? <Text style={styles.caption}>回答期限：{v2TargetLabel({ precision: 'instant', at: new Date(request.deadline.expiresAt).toISOString() }, model.plan.timeZone)}</Text> : null}
      {admin && !request.cancelled && ['pendingDelivery', 'awaiting'].includes(request.kind) ? <View style={styles.buttons}>
        <AppButton title="担当変更を承認" compact disabled={busy || answerPending} onPress={() => run(() => actions.answerAssignment(request.requestId, 'approve'))} />
        <AppButton title="担当変更を拒否" compact variant="secondary" disabled={busy || answerPending} onPress={() => run(() => actions.answerAssignment(request.requestId, 'reject'))} />
      </View> : null}
    </Card>;
  })}</View>;
}
const styles = StyleSheet.create({ list: { gap: 12 }, body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted },
  buttons: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
});
