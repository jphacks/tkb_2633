import { useState } from 'react';
import { Text } from 'react-native';
import { AppButton, Card, SectionHeading } from '../../../components/planner-ui';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import type { V2RoundReference } from '../v2/actions';
import { V2Choices, V2TextField, v2FormStyles as styles } from './form-controls';
import { v2LocalTimeInput } from './target-form';

/** Explicit work reporting is never autosaved; its performed time is separate from its recording time. */
export function V2CompletionForm(props: {
  model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan; actions: V2GroupController['actions'];
  busy: boolean; run: (work: () => Promise<unknown>) => Promise<void>; now?: () => Date;
}) {
  return <CompletionEditor key={`${props.model.plan.groupId}:${props.subject.id}`} {...props} />;
}

function CompletionEditor({ model, round, subject, actions, busy, run, now = () => new Date() }: Parameters<typeof V2CompletionForm>[0]) {
  const [when, setWhen] = useState<'now' | 'past'>('now'); const [day, setDay] = useState(''); const [clock, setClock] = useState('');
  const [performer, setPerformer] = useState(model.viewerUserId); const [error, setError] = useState<string | null>(null); const [submitted, setSubmitted] = useState(false);
  const [displayed] = useState(() => ({ ref: { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion,
    subjectUserId: subject.subjectUserId, expectedConfigurationIds: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId) } satisfies V2RoundReference,
  assignees: [...subject.assigneeIds] }));
  const canRecordOthers = model.viewerUserId === model.adminUserId || displayed.assignees.includes(model.viewerUserId);
  const performers = model.plan.members.filter((member) => member.active && (canRecordOthers || member.userId === model.viewerUserId));
  const disabled = busy || submitted || !model.plan.members.some((member) => member.active && member.userId === model.viewerUserId);
  const submit = () => {
    setError(null); let performedAt: string | undefined;
    try {
      if (displayed.ref.ruleVersion !== round.ruleVersion) throw new Error('周期が変更されています。現在の家事回を開き直してください。');
      if (!performers.some((member) => member.userId === performer)) throw new Error('現在参加している実施者を選んでください。');
      if (when === 'past') {
        performedAt = v2LocalTimeInput(day, clock, model.plan.timeZone);
        if (Date.parse(performedAt) > now().getTime()) throw new Error('実際に実施した、現在より前の日時を入力してください。');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '実施日時を確認してください。'); return; }
    return run(async () => { await actions.complete(displayed.ref, { ...(performedAt ? { performedAt } : {}), performerUserId: performer,
      expectedAssigneeIds: displayed.assignees }); setSubmitted(true); });
  };
  if (submitted) return <Card><Text accessibilityLiveRegion="polite" style={styles.body}>実施記録を端末に保存しました。共有状況は同期表示で確認できます。</Text></Card>;
  if (subject.completed || subject.pendingCompletionIds.length) return <Card><Text style={styles.body}>{subject.completed ? 'この家事回は実施済みです。' : '実施記録の確認・承認を待っています。'}</Text></Card>;
  return <Card><SectionHeading title="実施を記録" />
    <V2Choices label="実施した時期" value={when} onChange={setWhen} disabled={disabled}
      choices={[{ value: 'now', label: '今実施した' }, { value: 'past', label: '以前実施した' }]} />
    {when === 'past' ? <><V2TextField label="実施日" placeholder="YYYY-MM-DD" value={day} onChangeText={setDay} editable={!disabled} />
      <V2TextField label="実施時刻" placeholder="HH:mm" value={clock} onChangeText={setClock} editable={!disabled} />
      <Text style={styles.caption}>日時の地域：{model.plan.timeZone}。入力した実施日時と、この操作の記録日時を別々に保存します。</Text></> : null}
    <V2Choices label="実際に実施した人" value={performer} onChange={setPerformer} disabled={disabled}
      choices={performers.map((member) => ({ value: member.userId, label: `${member.displayName}${member.userId === model.viewerUserId ? '（あなた）' : ''}` }))} />
    {displayed.assignees.length && !displayed.assignees.includes(performer) ? <Text style={styles.caption}>{model.plan.policy?.allowSubstitution
      ? '代行として記録します。本来の担当・実施者・登録者をそれぞれ残します。' : '代行の実施事実を保存し、管理者の承認までは完了扱いにしません。'}</Text> : null}
    {subject.strictInstructionUnfulfilled || subject.formalDate.kind === 'manual' && subject.formalDate.strict ? <Text style={styles.caption}>実施した事実と、指定日時の条件を満たしたかを別々に判定します。</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    <AppButton title="実施を記録する" disabled={disabled} onPress={submit} />
  </Card>;
}
