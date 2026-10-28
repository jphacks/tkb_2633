import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, seeds, now, groupId, receiptsFor, draft } from './helpers/sharing-v2-repository-fixture.mjs';
import { createV2GroupController } from '../src/features/sharing/v2/controller.ts';
import { v2RuleTargetCandidates, materializeRuleTarget, v2RuleCalendarAnchorRange } from '../src/features/sharing/v2/rule-target.ts';
import { v2WallTimeCandidates } from '../src/features/sharing/v2/local-time.ts';
import { targetCivilDate } from '../src/features/sharing/v2/date-target.ts';
import { approvalDeadline } from '../src/features/sharing/v2/approval-deadline.ts';
import { screenHarness } from './helpers/screen-harness.mjs';
import { fixture as planFixture } from './helpers/sharing-v2-plan-fixture.mjs';
import { v2AssignmentRequestReference } from '../src/features/sharing/v2/assignment-state.ts';
import { frameAtOperation } from '../src/features/sharing/v2/authority-context.ts';
import { v2ReadPoint } from '../src/features/sharing/v2/view-point.ts';
import { fixedConflictAtOperation } from '../src/features/sharing/v2/fixed-conflict.ts';
import { v2CancellationProposal } from '../src/features/sharing/v2/cancellation-proposal.ts';
import { buildV2PersonalPlan } from '../src/features/sharing/v2/personal-plan.ts';
import { v2DateChangeOriginal } from '../src/features/sharing/v2/date-change-original.ts';
import { selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { v2OccurrenceId } from '../src/features/sharing/v2/occurrence-id.ts';
import { applyReceivedSharedFacts, loadSharedFacts, readSharingCheckpoint, listSharingOutbox } from '../src/platform/storage/sharing-ledger.ts';
const range = { from: '2026-10-27', through: '2026-11-10', asOfDate: '2026-10-27' };
const frame = (date = '2026-11-03') => ({ id: v2OccurrenceId(groupId, 'floor', date), groupId, choreId: 'floor', anchorDate: date,
  ruleVersion: 1, windowStart: date, windowEnd: date });
const rule = (patch = {}) => ({ id: 'old-clock', choreId: 'floor', subjectUserId: null, referenceAnchorDate: '2026-10-27',
  timeZoneAtCreation: 'Asia/Tokyo', selector: { scope: 'ongoing', from: '2026-10-27' }, mode: 'deadline',
  target: { precision: 'instant', at: '2026-10-28T10:00:00.000Z' }, strict: false, adminLocked: false, forbidEarlier: false,
  issuerUserId: 'owner', ruleVersion: 1, ...patch });
function controller(device, clock = now) { let n = 0; return createV2GroupController(device.repository, { now: clock, makeId: () => `zone-${device.options.userId}-${++n}`, sync: async () => {} }); }
async function setup({ timeZone = 'Asia/Tokyo', anchorDate = '2026-10-27', clock = now, window = 2, target = '2026-10-28T10:00:00.000Z', rulePatch = {} } = {}) {
  const f = await fixture({ clock }); const d = await f.device(); const initial = seeds();
  initial[0].payload.configuration.adminCanFixWithoutConsent = true; initial[1].payload.timeZone = timeZone; initial[1].payload.anchorDate = anchorDate;
  Object.assign(initial[3].payload.configuration, { anchorDate, windowBeforeDays: window, windowAfterDays: window });
  await d.repository.commit(initial); const original = rule({ timeZoneAtCreation: timeZone, referenceAnchorDate: anchorDate, selector: { scope: 'ongoing', from: anchorDate }, target: { precision: 'instant', at: target }, ...rulePatch });
  await d.repository.commit([draft(original.id, 'designation', original.id, { configuration: original })]);
  const c = controller(d, clock); assert.equal((await d.repository.readState()).assessment.view.ofType('designation').length, 1, 'the original signed designation must be authorized before changing regions');
  return { f, d, c, original, async move(zone = 'America/New_York') { await d.repository.commit([draft('changed-region', 'settings', 'settings', { timeZone: zone })]); }, close: () => d.connection.close() };
}

test('D9 existing repeating instants keep their creation region across another display region and its daylight saving changes', () => {
  for (const zone of ['UTC', 'America/New_York', 'Pacific/Honolulu']) assert.deepEqual(materializeRuleTarget(rule(), frame(), zone), {
    kind: 'target', target: { precision: 'instant', at: '2026-11-04T10:00:00.000Z' },
  });
});

test('D9 an original date-only designation retains its original end-of-day deadline after a region change', () => {
  const source = rule({ mode: 'day', target: { precision: 'date', date: '2026-10-28' } });
  const original = v2DateChangeOriginal([source], frame('2026-10-27'), 'America/New_York');
  assert.deepEqual(original.original, source.target); assert.equal(original.originalReferenceAt, Date.parse('2026-10-28T14:59:00.000Z'));
});

test('D9 equal date labels with different original deadlines remain a conflict while equivalent timezone aliases still merge', () => {
  const make = (id, timeZoneAtCreation) => ({ operationId: id, authorUserId: 'owner', authorDeviceId: id, deviceSequence: 1, logicalClock: 1, context: {},
    rule: rule({ id, timeZoneAtCreation, mode: 'deadline', target: { precision: 'date', date: '2026-10-28' } }) });
  assert.equal(selectManualRule([make('tokyo', 'Asia/Tokyo'), make('new-york', 'America/New_York')], frame('2026-10-27'), null, 'America/New_York').kind, 'conflict');
  assert.equal(selectManualRule([make('utc', 'UTC'), make('utc-alias', 'Etc/UTC')], frame('2026-10-27'), null, 'Asia/Tokyo').kind, 'selected');
});

test('D9 day instructions with equal end-of-day deadlines still conflict when a timezone transition gives them different day starts', () => {
  const make = (id, timeZoneAtCreation, mode) => ({ operationId: id, authorUserId: 'owner', authorDeviceId: id, deviceSequence: 1, logicalClock: 1, context: {},
    rule: rule({ id, timeZoneAtCreation, mode, target: { precision: 'date', date: '2026-10-25' } }) });
  assert.equal(selectManualRule([make('london', 'Europe/London', 'day'), make('utc', 'UTC', 'day')], frame('2026-10-27'), null, 'UTC').kind, 'conflict');
  assert.equal(selectManualRule([make('london', 'Europe/London', 'deadline'), make('utc', 'UTC', 'deadline')], frame('2026-10-27'), null, 'UTC').kind, 'selected');
});

test('D9 changing the group display region does not erase a source-region DST gap or its known original interval start', () => {
  const base = rule({ referenceAnchorDate: '2026-03-01', selector: { scope: 'ongoing', from: '2026-03-01' }, timeZoneAtCreation: 'America/New_York' });
  const missing = { ...base, target: { precision: 'instant', at: '2026-03-01T07:15:00.000Z' } };
  assert.deepEqual(v2RuleTargetCandidates(missing, frame('2026-03-08'), 'UTC'), { kind: 'missingTime', referenceTimes: [] });
  const interval = { ...base, target: { precision: 'interval', start: '2026-03-01T06:30:00.000Z', end: '2026-03-01T07:30:00.000Z' } };
  const original = v2DateChangeOriginal([interval], frame('2026-03-08'), 'UTC');
  assert.equal(original.originalMissingTime, true); assert.equal(original.originalReferenceAt, Date.parse('2026-03-08T06:30:00.000Z'));
});

test('D9 changing a group region preserves existing signed rule content round identities and repeating targets', async () => {
  const f = await setup();
  try {
    const before = await f.c.readModel(range); const original = (await loadSharedFacts(f.d.database, groupId)).find(fact => fact.operation.operationId === f.original.id);
    await f.move(); const after = await f.c.readModel(range);
    assert.equal(after.plan.timeZone, 'America/New_York');
    const first = before.plan.occurrences.find(row => row.anchorDate === '2026-11-03'); const next = after.plan.occurrences.find(row => row.id === first.id);
    assert.ok(next); assert.equal(next.subjects[0].formalDate.kind, 'manual'); assert.deepEqual(next.subjects[0].formalDate.target, { precision: 'instant', at: '2026-11-04T10:00:00.000Z' });
    assert.deepEqual((await loadSharedFacts(f.d.database, groupId)).find(fact => fact.operation.operationId === f.original.id), original);
  } finally { f.close(); }
});

test('D9 a completion after changing regions records the original designated timezone instead of replacing it with the current group zone', async () => {
  const f = await setup();
  try {
    await f.move(); await f.c.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null });
    const history = (await f.c.readModel(range)).plan.history; assert.equal(history.length, 1);
    assert.equal(history[0].instruction.kind, 'designated'); assert.equal(history[0].instruction.timeZone, 'Asia/Tokyo');
  } finally { f.close(); }
});

test('D9 preserving an old signed region does not permit a new author to forge that old region after settings changed', async () => {
  const f = await setup();
  try {
    await f.move(); const before = await listSharingOutbox(f.d.database, groupId);
    await assert.rejects(f.d.repository.commit([draft('forged-old-region', 'designation', 'forged-old-region', { configuration: { ...f.original, id: 'forged-old-region' } })]), /group timezone|authority/u);
    assert.deepEqual(await listSharingOutbox(f.d.database, groupId), before);
  } finally { f.close(); }
});

test('D9 inverse calendar queries include the source round when a new display region crosses midnight after DST', async () => {
  const f = await setup({ timeZone: 'UTC', anchorDate: '2026-10-25', clock: () => new Date('2026-10-20T01:00:00Z'), window: 0, target: '2026-10-25T04:30:00.000Z' });
  try {
    await f.move(); const model = await f.c.readModel({ from: '2026-11-07', through: '2026-11-07', asOfDate: '2026-11-07' });
    const occurrence = model.plan.occurrences.find(row => row.anchorDate === '2026-11-08'); assert.ok(occurrence, 'the prior local calendar day must still find this shifted source round');
    assert.equal(occurrence.subjects[0].formalDate.kind, 'manual'); assert.deepEqual(occurrence.subjects[0].formalDate.target, { precision: 'instant', at: '2026-11-08T04:30:00.000Z' });
  } finally { f.close(); }
});

test('D9 two isolated SQLite receivers converge on the original region after receiving the signed region change out of order', async () => {
  const f = await setup(); const member = await f.f.device('member', f.f.member);
  try {
    await f.move(); const facts = await loadSharedFacts(f.d.database, groupId);
    for (const d of [member, f.d]) { const checkpoint = await readSharingCheckpoint(d.database, groupId);
      await applyReceivedSharedFacts(d.database, groupId, [...facts].reverse(), 'zone-change', d.repository.project, checkpoint.cursor, now().getTime(), d.repository.evidenceForServerReceipts(receiptsFor(facts))); }
    const other = controller(member); const a = (await f.c.readModel(range)).plan; const b = (await other.readModel(range)).plan;
    assert.deepEqual(a, b); const occurrence = b.occurrences.find(row => row.anchorDate === '2026-11-03'); assert.equal(occurrence.subjects[0].formalDate.kind, 'manual');
  } finally { member.connection.close(); f.close(); }
});

test('D9 inverse queries cover cross-region midnight DST half-hour changes and date-line transitions without host clock assumptions', () => {
  const zones = ['Asia/Tokyo', 'UTC', 'America/New_York', 'Australia/Lord_Howe', 'Pacific/Apia', 'Pacific/Kiritimati', 'Pacific/Honolulu', 'Europe/Paris'];
  let checked = 0;
  for (const source of zones) for (const display of zones) for (const [referenceAnchorDate, day] of [
    ['2026-03-01', '2026-03-08'], ['2026-10-25', '2026-11-01'], ['2026-10-25', '2026-11-08'], ['2011-12-25', '2011-12-31'],
  ]) for (const hour of [0, 12, 23]) {
    const at = v2WallTimeCandidates({ date: referenceAnchorDate, hour, minute: 30, timeZone: source })[0];
    const value = rule({ referenceAnchorDate, timeZoneAtCreation: source, target: { precision: 'instant', at: new Date(at).toISOString() } });
    const result = v2RuleTargetCandidates(value, frame(day), display); if (result.kind !== 'targets') continue;
    for (const target of result.targets) {
      const civil = targetCivilDate(target, display); const bounds = v2RuleCalendarAnchorRange(value, civil, civil, display);
      assert.ok(bounds.from <= day && day <= bounds.through, `${source} -> ${display} ${day} must be found on ${civil}`); checked++;
    }
  }
  assert.ok(checked >= 700);
});

test('D9 receipt deadlines use authenticated old-region references in both timezone directions rather than recomputing them in the new region', () => {
  for (const [source, display, expected] of [['Asia/Tokyo', 'America/New_York', '2026-10-28T14:59:00Z'], ['America/New_York', 'Asia/Tokyo', '2026-10-29T03:59:00Z']]) {
    const original = v2DateChangeOriginal([rule({ mode: 'deadline', timeZoneAtCreation: source, target: { precision: 'date', date: '2026-10-28' } })], frame('2026-10-27'), display);
    const result = approvalDeadline({ serverRequestedAt: now().getTime(), ...original, proposed: { precision: 'date', date: '2026-10-31' }, timeZone: display });
    assert.equal(result.kind, 'open'); assert.equal(result.referenceAt, Date.parse(expected));
  }
});

test('D9 assignment requests compare each affected person using that instruction original region and bind the earliest exact reference', async () => {
  const f = await planFixture({ preset: 'eachMember' });
  f.designation({ precision: 'date', date: '2026-10-28' }, { subjectUserId: 'owner' });
  f.designation({ precision: 'date', date: '2026-11-01' }, { subjectUserId: 'b' });
  f.make('settings', { timeZone: 'America/New_York' }, { entityId: 'settings' });
  f.designation({ precision: 'date', date: '2026-10-27' }, { subjectUserId: 'a', timeZoneAtCreation: 'America/New_York' });
  const state = f.state(); assert.deepEqual(state.assessment.rejected, []); const view = state.assessment.view; const at = v2ReadPoint(view, f.archive.at(-1));
  const context = frameAtOperation(view, f.archive, at, 'floor', '2026-10-27', 1);
  assert.deepEqual(v2AssignmentRequestReference(view, at, context.frame, ['owner', 'a', 'b'], state.assessment.approvedRules), {
    reference: { precision: 'date', date: '2026-10-27' }, timeZone: 'America/New_York',
  });
});

test('D9 completion fulfillment after changing regions still judges an original date-only deadline in its source region', async () => {
  const f = await setup({ clock: () => new Date('2026-10-29T01:00:00Z'), rulePatch: { mode: 'deadline', strict: true, target: { precision: 'date', date: '2026-10-28' } } });
  try {
    await f.move(); await f.c.actions.complete({ choreId: 'floor', anchorDate: '2026-10-27', ruleVersion: 1, subjectUserId: null }, { performedAt: '2026-10-28T16:00:00Z' });
    const record = (await f.c.readModel(range)).plan.history[0]; assert.equal(record.fulfillment, 'later'); assert.equal(record.strictInstructionFulfilled, false);
    assert.equal(record.instruction.timeZone, 'Asia/Tokyo');
  } finally { f.close(); }
});

for (const platform of ['ios', 'android']) test(`${platform} D9 cards show the old region while new designation inputs use the current group region`, async () => {
  const f = await setup();
  try {
    await f.move(); const model = await f.c.readModel(range); const round = model.plan.occurrences.find((row) => row.anchorDate === '2026-10-27'); const subject = round.subjects[0];
    const props = { model, round, subject, actions: f.c.actions, busy: false, run: async (work) => { await work(); } };
    const card = screenHarness('src/features/sharing/v2-ui/round-card.tsx', { platform, exportName: 'V2RoundCard', props: { ...props, onOpen() {} } });
    assert.ok(card.text().includes('期限：10月28日 19:00')); assert.ok(card.text().includes('指定時の地域：Asia/Tokyo'));
    const screen = screenHarness('src/features/sharing/v2-ui/date-form.tsx', { platform, exportName: 'V2DateForm', props });
    assert.ok(screen.text().includes('現在の指定：10月28日 19:00 · Asia/Tokyo')); assert.ok(screen.text().includes('新しく指定する日時にはAmerica/New_York'));
    assert.equal(screen.nodes().find((node) => node.type === 'TextInput' && node.props.accessibilityLabel === '期限の時刻（任意）').props.value, '06:00');
    await screen.change('期限の時刻（任意）', '07:00'); await screen.press('日時を指定・申請する'); assert.ok(screen.text().includes('日時指定を端末に保存'));
    const rules = (await f.d.repository.readState()).assessment.view.ofType('designation');
    assert.equal(rules.length, 2); const added = rules.find((op) => op.operationId !== f.original.id).payload.configuration;
    assert.equal(added.timeZoneAtCreation, 'America/New_York'); assert.deepEqual(added.target, { precision: 'instant', at: '2026-10-28T11:00:00.000Z' });
  } finally { f.close(); }
});

test('D9 original-region recurring fixed intervals still reject another overlapping assignment after a group timezone change', async () => {
  const f = await planFixture({ preset: 'assigned', members: ['a'] });
  f.designation({ precision: 'interval', start: '2026-10-27T04:30:00Z', end: '2026-10-27T05:30:00Z' }, { selector: { scope: 'ongoing', from: '2026-10-27' } });
  f.make('settings', { timeZone: 'America/New_York' }, { entityId: 'settings' });
  const state = f.state(); assert.deepEqual(state.assessment.rejected, []); const view = state.assessment.view; const at = v2ReadPoint(view, f.archive.at(-1));
  const check = (start, end, uid = 'a') => fixedConflictAtOperation(view, f.archive, at, { precision: 'interval', start, end }, [uid],
    { occurrenceId: 'another-round', subjectUserId: null }, state.assessment.approvedRules);
  assert.equal(check('2026-11-03T04:45:00Z', '2026-11-03T05:15:00Z'), true);
  assert.equal(check('2026-11-03T05:30:00Z', '2026-11-03T06:00:00Z'), false);
  assert.equal(check('2026-11-03T04:45:00Z', '2026-11-03T05:15:00Z', 'b'), false);
});

test('D9 an administrator-approved future window keeps its original civil-day extension after the group region changes', async () => {
  const f = await planFixture({ preset: 'assigned', members: ['a'] });
  f.make('changeRequest', { requesterUserId: 'owner', choreId: 'floor', anchorDate: '2026-10-27', occurrenceId: f.occurrence(), subjectUserId: null,
    originalDesignationId: null, original: { precision: 'date', date: '2026-10-27' },
    proposed: { precision: 'interval', start: '2026-11-01T00:15:00Z', end: '2026-11-01T00:45:00Z' }, proposedMode: 'fixed',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrence(), anchorDate: '2026-10-27' }, extensionScope: 'future' });
  assert.deepEqual(f.state().assessment.rejected, []); assert.equal(f.state().assessment.requestStates[0].kind, 'approved');
  const before = f.plan().occurrences.map((entry) => [entry.id, entry.windowStart, entry.windowEnd]);
  f.make('settings', { timeZone: 'America/New_York' }, { entityId: 'settings' }); assert.deepEqual(f.state().assessment.rejected, []);
  const after = f.plan(); assert.deepEqual(after.occurrences.map((entry) => [entry.id, entry.windowStart, entry.windowEnd]), before);
  assert.equal(after.occurrences[0].windowEnd, '2026-11-01'); assert.equal(after.occurrences[1].windowEnd, '2026-11-08');
  assert.equal(after.issues.some((entry) => entry.kind === 'windowExtensionNeedsReview'), false);
});

test('D9 a recurring date-only instruction on a skipped source-region civil day stays unresolved instead of breaking the plan or inventing a date', () => {
  const source = rule({ referenceAnchorDate: '2011-12-25', selector: { scope: 'ongoing', from: '2011-12-25' }, timeZoneAtCreation: 'Pacific/Apia', mode: 'day', target: { precision: 'date', date: '2011-12-25' } });
  assert.deepEqual(v2RuleTargetCandidates(source, frame('2011-12-30'), 'UTC'), { kind: 'missingTime', referenceTimes: [] });
  const original = v2DateChangeOriginal([source], frame('2011-12-30'), 'UTC'); assert.equal(original.originalMissingTime, true); assert.equal(original.originalReferenceAt, null);
  assert.equal(materializeRuleTarget(source, frame('2011-12-30'), 'UTC').kind, 'review');
});

test('D9 offline rules bind the region actually observed by their author while a concurrent administrator change cannot reinterpret them', async () => {
  const f = await planFixture(); const before = f.facts.map((fact) => fact.operation);
  f.make('settings', { timeZone: 'America/New_York' }, { entityId: 'settings' });
  const old = f.designation({ precision: 'interval', start: '2026-10-27T01:00:00Z', end: '2026-10-27T02:00:00Z' },
    { actor: 'owner2', observed: before, selector: { scope: 'ongoing', from: '2026-10-27' } });
  assert.deepEqual(f.state().assessment.rejected, []);
  const next = f.plan().occurrences.find((row) => row.anchorDate === '2026-11-03').subjects[0].formalDate;
  assert.equal(next.ruleId, old.operationId); assert.equal(next.timeZone, 'Asia/Tokyo'); assert.deepEqual(next.target,
    { precision: 'interval', start: '2026-11-03T01:00:00.000Z', end: '2026-11-03T02:00:00.000Z' });
  assert.deepEqual(f.plan(), f.plan({}, [...f.facts].reverse()));
});

test('D9 removal references retain the region of the remaining rule instead of treating its date as a new-region instruction', () => {
  const make = (id, value, extra = {}) => ({ operationId: id, authorUserId: 'owner', authorDeviceId: id, deviceSequence: 1, logicalClock: 1, context: {},
    rule: rule({ id, mode: 'day', target: { precision: 'date', date: value }, ...extra }) });
  const old = make('ongoing', '2026-10-28'); const once = make('once', '2026-10-30', { timeZoneAtCreation: 'America/New_York',
    selector: { scope: 'once', occurrenceId: frame('2026-10-27').id, anchorDate: '2026-10-27' } });
  const after = v2CancellationProposal([old, once], frame('2026-10-27'), null, 'America/New_York', { targetOperationIds: ['once'], selector: null });
  assert.equal(after.timeZone, 'Asia/Tokyo'); assert.equal(after.referenceAt, Date.parse('2026-10-28T14:59:00Z'));
  const deadline = approvalDeadline({ serverRequestedAt: now().getTime(), original: once.rule.target, originalReferenceAt: Date.parse('2026-10-31T03:59:00Z'),
    proposed: after.target, proposedReferenceAt: after.referenceAt, timeZone: 'America/New_York' });
  assert.equal(deadline.referenceAt, after.referenceAt);
});

test('D9 a date-only deadline across the date line appears on its actual current-region deadline day and personal load cannot postpone it', async () => {
  const f = await setup({ timeZone: 'Pacific/Kiritimati', rulePatch: { mode: 'deadline', target: { precision: 'date', date: '2026-10-28' } } });
  try {
    await f.move('Pacific/Honolulu'); const common = (await f.c.readModel(range)).plan;
    const round = common.occurrences.find((row) => row.anchorDate === '2026-10-27'); assert.equal(round.subjects[0].suggestedDate, '2026-10-27');
    const personal = buildV2PersonalPlan(common, { viewerUserId: 'owner', now: now().getTime(),
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 1 } },
      privateLoad: { ownerUserId: 'owner', days: { '2026-10-27': { heavy: 0, normal: 10, total: 10 } } } });
    const recommendation = personal.recommendations.find((row) => row.occurrenceId === round.id); assert.equal(recommendation.date, '2026-10-27');
    assert.ok(recommendation.reasons.includes('dailyLoadExceeded'));
  } finally { f.close(); }
  const other = await setup({ timeZone: 'Pacific/Kiritimati', window: 0, rulePatch: { mode: 'deadline', target: { precision: 'date', date: '2026-10-27' } } });
  try {
    await other.move('Pacific/Honolulu'); const later = await other.c.readModel({ from: '2026-11-02', through: '2026-11-02', asOfDate: '2026-11-02' });
    const next = later.plan.occurrences.find((row) => row.anchorDate === '2026-11-03'); assert.ok(next); assert.equal(next.subjects[0].suggestedDate, '2026-11-02');
  } finally { other.close(); }
});
