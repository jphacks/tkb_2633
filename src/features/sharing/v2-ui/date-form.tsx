import { useRef, useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card, SectionHeading } from '../../../components/planner-ui';
import { canonicalJson } from '../operations';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import type { V2PlannedOccurrence, V2SubjectPlan } from '../v2/common-plan';
import { V2ActionConfirmationError } from '../v2/actions';
import type { V2RoundReference } from '../v2/actions';
import { v2DateChangeOriginal } from '../v2/date-change-original';
import type { DateTarget, DesignationMode, RuleSelector } from '../v2/model';
import type { CalendarConflict } from '../v2/private-availability';
import { V2Choices, V2Flag, V2TextField, v2FormStyles as styles } from './form-controls';
import { v2InitialTargetFields, v2RuleSelectorFromForm, v2TargetFromEditedForm, v2TargetLabel } from './target-form';
import type { V2ValidityChoice } from './target-form';
import { V2DateTargetFields } from './date-target-fields';
import { V2DateConfirmation } from './date-confirmation';

const ruleIdsOf = (formal: V2SubjectPlan['formalDate']) => formal.kind === 'automatic' ? [] : formal.kind === 'manual' ? formal.equivalentRuleIds : formal.ruleIds;
const sameIds = (a: readonly string[], b: readonly string[]) => canonicalJson([...a].sort()) === canonicalJson([...b].sort());
type ConfirmationKind = 'recentWork' | 'highLoad' | 'calendar' | 'cancel';
type Props = { model: V2GroupScreenModel; round: V2PlannedOccurrence; subject: V2SubjectPlan; actions: V2GroupController['actions']; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void>; readOwnCalendar?: (target: DateTarget) => Promise<CalendarConflict> };
function displayedState({ model, round, subject }: Props) {
  const formal = subject.formalDate;
  const ruleIds = ruleIdsOf(formal);
  const rules = model.dateRules.filter((fact) => ruleIds.includes(fact.operationId));
  const target: DateTarget = formal.kind === 'manual' ? formal.target : { precision: 'date', date: round.anchorDate };
  const mode: DesignationMode = formal.kind === 'manual' ? formal.mode : rules.length === 1 ? rules[0].rule.mode : 'day';
  const ref: V2RoundReference = { choreId: round.choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: subject.subjectUserId,
    expectedConfigurationIds: model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId), expectedTimeZone: model.plan.timeZone };
  let originalMissingTime = false;
  try { const source = v2DateChangeOriginal(rules.map((fact) => fact.rule), round, model.plan.timeZone); originalMissingTime = source.originalMissingTime && source.originalReferenceAt === null; } catch { /* Changed recurrence and timezone stay explicit reviews. */ }
  return { ref, ruleIds, rules, target, mode, originalMissingTime, timeZone: model.plan.timeZone, assignees: [...subject.assigneeIds],
    assignmentIds: [...round.assignmentOperationIds], conflictIds: [...round.assignmentConflictIds], reviewIds: [...subject.requestReviewIds],
    needsReview: formal.kind === 'conflict' || formal.kind === 'review' || subject.requestReviewIds.length > 0,
    fields: v2InitialTargetFields(target, model.plan.timeZone),
    options: { strict: rules.some((fact) => fact.rule.strict), adminLocked: rules.some((fact) => fact.rule.adminLocked), forbidEarlier: rules.some((fact) => fact.rule.forbidEarlier) } };
}

/** Date changes are explicit signed commands. Typing never changes an existing formal schedule. */
export function V2DateForm(props: Props) {
  return <DateEditor key={`${props.round.id}:${props.subject.id}`} {...props} />;
}
function DateEditor(props: Props) {
  const { model, round, subject, actions, busy, run, readOwnCalendar } = props;
  const [displayed] = useState(() => displayedState(props));
  const [draft, setDraft] = useState(() => ({ mode: displayed.mode, fields: displayed.fields, validity: 'once' as V2ValidityChoice,
    through: '', extension: 'once' as 'once' | 'future', options: displayed.options, reviewed: false }));
  const input = useRef(draft);
  const { mode, fields, validity, through, extension, options, reviewed } = draft;
  const [error, setError] = useState<string | null>(null);
  const [confirmation, setConfirmation] = useState<{ kind: ConfirmationKind; revision: number } | null>(null);
  const inputRevision = useRef(0);
  const askConfirmation = (kind: ConfirmationKind) => setConfirmation({ kind, revision: inputRevision.current });
  const [calendarStatus, setCalendarStatus] = useState<'unknown' | 'clear' | 'conflict'>('unknown');
  const [success, setSuccess] = useState<string | null>(null); const [saving, setSaving] = useState(false); const inFlight = useRef(false);
  const confirmed = useRef({ recentWork: false, highLoad: false, calendar: false });
  const zoneChanged = displayed.timeZone !== model.plan.timeZone;
  const staleAssignment = !sameIds(displayed.assignees, subject.assigneeIds) || !sameIds(displayed.assignmentIds, round.assignmentOperationIds) || !sameIds(displayed.conflictIds, round.assignmentConflictIds);
  const staleDate = !sameIds(displayed.ruleIds, ruleIdsOf(subject.formalDate)) || !sameIds(displayed.reviewIds, subject.requestReviewIds);
  const staleConfiguration = !sameIds(displayed.ref.expectedConfigurationIds ?? [], model.configurations.find((entry) => entry.choreId === round.choreId)?.candidates.map((entry) => entry.operationId) ?? []);
  const stale = zoneChanged || staleAssignment || staleDate || staleConfiguration;
  const disabled = busy || saving || stale || !model.plan.initialized || Boolean(success)
    || !round.activeInPeriod || Boolean(round.assignmentConflictIds.length) || !model.plan.members.some((member) => member.active && member.userId === model.viewerUserId);
  const admin = model.viewerUserId === model.adminUserId;
  const ownCalendar = displayed.assignees.includes(model.viewerUserId) ? readOwnCalendar : undefined;
  const edit = (patch: Partial<typeof draft>) => {
    if (inFlight.current) return;
    inputRevision.current++; input.current = { ...input.current, ...patch }; setDraft(input.current);
    setCalendarStatus('unknown'); setConfirmation(null); setError(null); confirmed.current = { recentWork: false, highLoad: false, calendar: false };
  };
  const field = (name: keyof typeof fields, value: string) => edit({ fields: { ...input.current.fields, [name]: value,
    ...(['day', 'clock'].includes(name) ? { clockChoice: '' } : ['endDay', 'endClock'].includes(name) ? { endClockChoice: '' } : {}) } });
  const submit = async () => {
    if (disabled || inFlight.current) return;
    const { mode, fields, validity, through, extension, options, reviewed } = input.current;
    setError(null); let target: DateTarget; let selector: RuleSelector;
    try {
      if (displayed.needsReview && !reviewed) throw new Error('元の指定と競合している内容を確認してください。');
      target = v2TargetFromEditedForm({ mode, ...fields, timeZone: displayed.timeZone, clockChoice: fields.clockChoice || undefined,
        endClockChoice: fields.endClockChoice || undefined }, displayed.target, displayed.fields);
      selector = v2RuleSelectorFromForm(validity, round, through);
      const rank = (scope: string) => scope === 'once' ? 3 : scope === 'period' ? 2 : 1;
      if (displayed.rules.some((fact) => rank(fact.rule.selector.scope) > rank(selector.scope)) && canonicalJson(target) !== canonicalJson(displayed.target)) {
        throw new Error('この回の個別指定が優先されます。今回だけを選んで変更するか、元の指定を解除してから期間を指定してください。');
      }
    } catch (cause) { setError(cause instanceof Error ? cause.message : '変更する日時を確認してください。'); return; }
    inFlight.current = true; setSaving(true);
    try { await run(async () => {
      if (mode === 'fixed' && ownCalendar && !confirmed.current.calendar) {
        const reading = await ownCalendar(target); setCalendarStatus(reading.kind);
        if (reading.kind === 'conflict') { askConfirmation('calendar'); return; }
      }
      try {
        const created = await actions.changeDate(displayed.ref, { mode, target, selector, options, extensionScope: extension,
          expectedRuleIds: displayed.ruleIds, confirmDateConflict: reviewed, reviewedRequestIds: displayed.reviewIds,
          expectedAssigneeIds: displayed.assignees, expectedAssignmentIds: displayed.assignmentIds, expectedConflictIds: displayed.conflictIds,
          expectedRequestReviewIds: displayed.reviewIds, confirmRecentWork: confirmed.current.recentWork, confirmHighLoad: confirmed.current.highLoad });
        setSuccess(created[0]?.entityType === 'changeRequest' ? '変更申請を端末に保存しました。受付と必要な承認の確認まで正式予定は変わりません。'
          : '日時指定を端末に保存しました。他のメンバーへの反映状況は同期表示で確認できます。'); setConfirmation(null);
      } catch (cause) {
        if (cause instanceof V2ActionConfirmationError) { askConfirmation(cause.reason); return; } throw cause;
      }
    }); } finally { inFlight.current = false; setSaving(false); }
  };
  const cancel = async (revision: number) => {
    if (revision !== inputRevision.current) { setConfirmation(null); return; }
    if (disabled || inFlight.current) return;
    inFlight.current = true; setSaving(true);
    try { await run(async () => { await actions.cancelDates(displayed.ref, displayed.ruleIds, { expectedRuleIds: displayed.ruleIds });
      setSuccess('表示した日時指定を解除しました。実施履歴は保持されています。'); setConfirmation(null); }); }
    finally { inFlight.current = false; setSaving(false); }
  };
  if (success) return <Card><Text accessibilityLiveRegion="polite" style={styles.body}>{success}</Text></Card>;
  if (!model.plan.initialized) return <Card><Text style={styles.body}>グループの地域と基本設定が未確定です。先に設定を確認してください。</Text></Card>;
  return <Card><SectionHeading title="日時の指定・変更" />
    {stale ? <Text accessibilityRole="alert" style={styles.error}>地域・担当・日時指定または共通設定が変更されています。入力は保持しています。現在の内容を確認して開き直してください。</Text> : null}
    <Text style={styles.caption}>日時の地域：{displayed.timeZone}。基本周期と完了済みの履歴は変更しません。</Text>
    {displayed.needsReview ? <View style={{ gap: 8 }}><Text style={styles.error}>元の指定が未確定か、回答が競合しています。内容を確認して申請してください。</Text>
      {displayed.rules.map((fact) => <Text key={fact.operationId} style={styles.caption}>元の指定：{v2TargetLabel(fact.rule.target, fact.rule.timeZoneAtCreation)} · {fact.rule.selector.scope === 'once' ? '今回だけ' : '繰り返しの基準回'}</Text>)}
      {displayed.originalMissingTime ? <Text style={styles.caption}>元の時刻がこの地域には存在しないため、変更先を基準に申請期限を計算します。承認までは元の正式時刻は未確定です。</Text> : null}
      <V2Flag label="元の指定・競合内容を確認した" value={reviewed} onChange={(value) => edit({ reviewed: value })} disabled={disabled} />
    </View> : null}
    <V2Choices label="指定の種類" value={mode} onChange={(value) => edit({ mode: value })} disabled={disabled}
      choices={[{ value: 'deadline', label: '期限までに実施' }, { value: 'day', label: 'この日に実施' }, { value: 'fixed', label: '固定日時に実施' }]} />
    <V2DateTargetFields mode={mode} fields={fields} timeZone={displayed.timeZone} disabled={disabled} onChange={field} />
    {mode === 'fixed' ? <Text style={styles.caption}>Google Calendarの競合：{calendarStatus === 'clear' ? '取得済みの本人用情報の範囲では重複なし' : calendarStatus === 'conflict' ? '本人の予定と重複' : '未確認'}。{ownCalendar ? '本人用の情報で保存前に確認します。' : ''}他の人の予定内容は表示しません。</Text> : null}
    <V2Choices label="日時指定の適用範囲" value={validity} onChange={(value) => edit({ validity: value })} disabled={disabled}
      choices={[{ value: 'once', label: '今回だけ' }, { value: 'twoWeeks', label: '2週間' }, { value: 'oneMonth', label: '1か月' }, { value: 'endDate', label: '終了日を指定' }, { value: 'ongoing', label: '無期限' }]} />
    {validity === 'endDate' ? <V2TextField label="適用する最後の基準日" value={through} placeholder="YYYY-MM-DD" editable={!disabled} onChangeText={(value) => edit({ through: value })} /> : null}
    {validity !== 'once' ? <Text style={styles.caption}>今回の基準日からの日数差と現地時刻を各回へ適用します。夏時間などで確定できない回は確認が必要です。</Text> : null}
    <V2Choices label="期間外変更が承認された場合の実施可能期間" value={extension} onChange={(value) => edit({ extension: value })} disabled={disabled}
      choices={[{ value: 'once', label: '今回の実施可能期間だけ' }, { value: 'future', label: '今後の実施可能期間にも適用' }]} />
    {(['strict', 'adminLocked', 'forbidEarlier'] as const).map((key) => <V2Flag key={key} label={key === 'strict' ? '指定日時を厳守' : key === 'adminLocked' ? '管理者による固定' : '前倒しを禁止'}
      value={options[key]} disabled={disabled || !admin} onChange={(value) => edit({ options: { ...input.current.options, [key]: value } })} />)}
    {!admin ? <Text style={styles.caption}>元の厳守・固定・前倒し禁止の条件を維持して申請します。</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error}>{error}</Text> : null}
    {confirmation && confirmation.kind !== 'cancel' ? <V2DateConfirmation kind={confirmation.kind} disabled={disabled}
      onConfirm={() => { if (confirmation.revision !== inputRevision.current || confirmation.kind === 'cancel') { setConfirmation(null); return; }
        confirmed.current[confirmation.kind] = true; setConfirmation(null); return submit(); }}
      onCancel={() => { setConfirmation(null); confirmed.current = { recentWork: false, highLoad: false, calendar: false }; }} />
      : <AppButton title="日時を指定・申請する" disabled={disabled} onPress={submit} />}
    {admin && displayed.rules.length ? <View style={{ gap: 8 }}>
      {confirmation?.kind === 'cancel' ? <><Text style={styles.error}>{displayed.rules.some((fact) => fact.rule.selector.scope !== 'once') ? '次の元指定を適用期間全体から解除します。今回以外の回にも影響します。実施履歴は残ります。' : 'この回の日時指定を解除します。実施履歴は残ります。'}</Text>
        {displayed.rules.map((fact) => <Text key={fact.operationId} style={styles.caption}>{fact.rule.selector.scope === 'once' ? `今回だけ：${fact.rule.selector.anchorDate}`
          : fact.rule.selector.scope === 'ongoing' ? `${fact.rule.selector.from}から無期限` : `${fact.rule.selector.range.from}〜${fact.rule.selector.range.through ?? '無期限'}`}</Text>)}
        <AppButton title="表示した適用期間の指定を解除する" disabled={disabled} onPress={() => cancel(confirmation.revision)} />
        <AppButton title="解除せず戻る" variant="quiet" disabled={disabled} onPress={() => setConfirmation(null)} /></>
        : <AppButton title="適用中の日時指定を解除…" variant="quiet" disabled={disabled} onPress={() => askConfirmation('cancel')} />}
    </View> : null}
  </Card>;
}
