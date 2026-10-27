import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { sharingTestCrypto as crypto } from './helpers/sharing-crypto.mjs';
import { createDeviceIdentity } from '../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice, transferSharedOwnership } from '../src/features/sharing/roster.ts';
import { validateSharedOperation } from '../src/features/sharing/operations.ts';
import { buildSharedReplica, compactSharedReplica } from '../src/features/sharing/replica.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { v2OccurrenceId, v2SubjectOccurrenceId, v2DatePermissionId } from '../src/features/sharing/v2/occurrence-id.ts';
import { validateV2BusinessHistory, assessV2BusinessHistory, dateChangeContextAtOperation } from '../src/features/sharing/v2/receiver-authority.ts';
import { createV2HistoryView } from '../src/features/sharing/v2/history-view.ts';
import { frameAtOperation } from '../src/features/sharing/v2/authority-context.ts';
import { commonFrame, commonFrames } from '../src/features/sharing/v2/common-frames.ts';
import { materializeRuleTarget } from '../src/features/sharing/v2/rule-target.ts';

const groupId = 'v2-authority-test'; const anchorDate = '2026-10-27'; const recordedAt = '2026-10-27T01:00:00Z';
const date = (value) => ({ precision: 'date', date: value });
const time = (start, end) => ({ precision: 'interval', start, end });
const config = (preset = 'common', members = []) => ({ policy: chorePolicyFromPreset(preset, members), anchorDate,
  intervalDays: 7, windowBeforeDays: 2, windowAfterDays: 2, ruleVersion: 1 });

async function fixture(preset = 'common', members = [], policy = createGroupPolicy('family')) {
  const identities = Object.fromEntries(await Promise.all(['owner', 'a', 'b'].map(async (uid) => [uid, await createDeviceIdentity(crypto)])));
  const archive = [createSharedRoster(groupId, 'owner', identities.owner, { schemaVersion: 2 })];
  for (const uid of ['a', 'b']) archive.push(approveSharedDevice(archive.at(-1), identities.owner, uid, identities[uid]));
  const operations = []; let nextId = 0;
  function make(user, entityType, payload, { entityId, operationType = 'patch', observed = operations, keyVersion = archive.at(-1).body.keyVersion } = {}) {
    const operationId = `op-${String(++nextId).padStart(4, '0')}`;
    const context = {};
    for (const fact of observed) {
      context[fact.authorDeviceId] = Math.max(context[fact.authorDeviceId] ?? 0, fact.deviceSequence);
      for (const [id, value] of Object.entries(fact.context)) context[id] = Math.max(context[id] ?? 0, value);
    }
    const op = validateSharedOperation({ schemaVersion: 2, operationId, groupId, authorUserId: user, authorDeviceId: identities[user].deviceId,
      deviceSequence: (context[identities[user].deviceId] ?? 0) + 1, logicalClock: Math.max(0, ...observed.map((fact) => fact.logicalClock)) + 1,
      context, keyVersion, recordedAt, entityType, entityId: entityId ?? operationId, operationType, payload });
    operations.push(op); return op;
  }
  make('owner', 'groupPolicy', { configuration: policy }, { entityId: 'policy' });
  make('owner', 'settings', { timeZone: 'Asia/Tokyo', anchorDate }, { entityId: 'settings' });
  make('owner', 'chore', { name: '床を掃除する', enabled: true }, { entityId: 'floor' });
  make('owner', 'chorePolicy', { configuration: config(preset, members) }, { entityId: 'floor' });
  const occurrenceId = v2OccurrenceId(groupId, 'floor', anchorDate);
  const validate = (facts = operations, rosters = archive) => validateV2BusinessHistory(buildSharedReplica(groupId, facts), rosters);
  const claim = (uid, observed = operations) => make(uid, 'claim', { choreId: 'floor', anchorDate, occurrenceId, userId: uid }, { observed });
  const designation = (uid, target, { choreId = 'floor', subjectUserId = null, selector, strict = false, adminLocked = false, forbidEarlier = false, basisRuleIds, observed = operations } = {}) => {
    const id = `op-${String(nextId + 1).padStart(4, '0')}`;
    return make(uid, 'designation', { configuration: { id, choreId, subjectUserId, referenceAnchorDate: anchorDate, timeZoneAtCreation: 'Asia/Tokyo',
      selector: selector ?? { scope: 'once', occurrenceId: v2OccurrenceId(groupId, choreId, anchorDate), anchorDate },
      mode: target.precision === 'interval' ? 'fixed' : 'day', target, strict, adminLocked, forbidEarlier, issuerUserId: uid, ruleVersion: 1,
      ...(basisRuleIds ? { basisRuleIds } : {}) } }, { observed });
  };
  const complete = (uid, subjectUserId = null, originalAssigneeIds = [], performer = uid) => make(uid, 'completion', {
    choreId: 'floor', anchorDate, completedAt: '2026-10-26T23:00:00Z', completedByMemberId: performer,
    subjectUserId, originalAssigneeIds, ruleVersion: 1, outcome: 'completed',
  }, { entityId: v2SubjectOccurrenceId(occurrenceId, subjectUserId), operationType: 'complete' });
  return { identities, archive, operations, make, validate, occurrenceId, claim, designation, complete };
}

test('v2 receiver allows member names and procedures but denies common cadence, activation, deletion and administrator policy changes', async () => {
  for (const forbidden of [
    ['chore', { enabled: false }, 'floor'], ['chore', { load: 'heavy' }, 'floor'],
    ['chore', { userIntervalDays: 17 }, 'floor'], ['chorePolicy', { configuration: config() }, 'floor'],
    ['groupPolicy', { configuration: createGroupPolicy('roommates') }, 'policy'], ['settings', { timeZone: 'UTC' }, 'settings'],
  ]) {
    const f = await fixture(); f.make('a', forbidden[0], forbidden[1], { entityId: forbidden[2] }); assert.throws(() => f.validate(), { code: 'sharing/v2-authority-denied' });
  }
  const f = await fixture(); f.make('a', 'chore', { name: '別の家事', enabled: false, instructions: ['道具を用意する'] }, { entityId: 'new-chore' });
  f.make('b', 'chore', { name: '床掃除', instructions: ['ほこりを取る'] }, { entityId: 'floor' }); f.validate();
  f.make('a', 'chore', {}, { entityId: 'floor', operationType: 'delete' }); assert.throws(() => f.validate(), { code: 'sharing/v2-authority-denied' });
});
test('v2 receiver binds scoped grants to the actual chore and user and does not grant rights from the delegation toggle alone', async () => {
  const f = await fixture('assigned', ['owner']); const before = [...f.operations];
  const denied = f.designation('a', date('2026-10-28')); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const grant = f.make('owner', 'datePermission', { choreId: 'floor', userId: 'a', enabled: true,
    rights: { changeDate: true, changeOthers: true, changeBeforeWindow: false } }, { entityId: v2DatePermissionId(groupId, 'floor', 'a') });
  const allowed = f.designation('a', date('2026-10-28')); f.validate();
  const revoke = f.make('owner', 'datePermission', { ...grant.payload, enabled: false }, { entityId: grant.entityId, observed: [...before, grant] });
  for (const facts of [[...before, grant, allowed, revoke], [...before, revoke, allowed, grant]]) f.validate(facts);
  assert.equal(denied.authorUserId, 'a');
  f.designation('a', date('2026-10-29')); assert.throws(() => f.validate(), /requires a signed request/);
});
test('v2 receiver retains simultaneous claims as provisional and refuses a later claim that observed another assignee', async () => {
  const f = await fixture(); const base = [...f.operations]; const first = f.claim('a', base); const second = f.claim('b', base); f.validate();
  const probe = f.make('owner', 'member', { displayName: '管理者' }, { entityId: 'owner' }); f.validate();
  for (const facts of [f.operations, [...base, second, first, probe]]) {
    const view = createV2HistoryView(buildSharedReplica(groupId, facts));
    const state = frameAtOperation(view, f.archive, probe, 'floor', anchorDate);
    assert.deepEqual(state.assigneeIds, ['a', 'b']); assert.equal(state.claims.kind, 'provisional');
  }
  f.claim('owner'); assert.throws(() => f.validate(), /already observed/);
});
test('v2 receiver checks release targets and administrator resolution without deleting the provisional work history', async () => {
  const f = await fixture(); const base = [...f.operations]; const a = f.claim('a', base); const b = f.claim('b', base);
  const work = f.complete('a', null, ['a', 'b']); f.validate();
  const resolution = { choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, claimOperationIds: [a.operationId, b.operationId], assigneeIds: ['b'], fixed: true };
  f.make('a', 'claimResolution', resolution); assert.throws(() => f.validate(), { code: 'sharing/v2-authority-denied' }); f.operations.pop();
  f.make('owner', 'claimResolution', resolution); f.validate(); assert.ok(f.operations.includes(work));
  f.make('b', 'claimRelease', { choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, userId: 'b', targetOperationIds: [b.operationId] });
  assert.throws(() => f.validate(), /fixed assignment/); f.operations.pop();
  f.make('a', 'claimRelease', { choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, userId: 'a', targetOperationIds: [b.operationId] });
  assert.throws(() => f.validate(), /another claim/); f.operations.pop();
  f.make('a', 'claimRelease', { choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, userId: 'a', targetOperationIds: [a.operationId] }); f.validate();
});
test('v2 receiver requires locked date changes to be requests and prevents another member from approving an administrator-only change', async () => {
  const f = await fixture('assigned', ['a']); const locked = f.designation('owner', date('2026-10-28'), { adminLocked: true }); f.validate();
  f.designation('a', date('2026-10-27')); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const request = f.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: locked.operationId, original: date('2026-10-28'), proposed: date('2026-10-30'), proposedMode: 'day', proposedOptions: { strict: false, adminLocked: true, forbidEarlier: false },
    selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' }); f.validate();
  const decision = { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null };
  f.make('b', 'requestDecision', decision); assert.throws(() => f.validate(), /designated approver/); f.operations.pop();
  f.make('owner', 'requestDecision', decision); f.validate();
});
test('v2 receiver preserves roommate assignee consent and requires the affected member to accept an administrator counteroffer', async () => {
  const f = await fixture('assigned', ['a'], createGroupPolicy('roommates'));
  f.designation('owner', date('2026-10-28')); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const request = f.make('owner', 'changeRequest', { requesterUserId: 'owner', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: null, original: date(anchorDate), proposed: date('2026-10-28'), proposedMode: 'day', proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false },
    selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' });
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null });
  assert.throws(() => f.validate(), /designated approver/); f.operations.pop();
  f.make('a', 'requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null }); f.validate();
  const proposal = f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'counteroffer', target: date('2026-10-29'), referenceDecisionId: null });
  f.make('b', 'requestDecision', { requestId: request.operationId, decision: 'acceptCounteroffer', target: null, referenceDecisionId: proposal.operationId });
  assert.throws(() => f.validate(), /affected consenting member/); f.operations.pop();
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'acceptCounteroffer', target: null, referenceDecisionId: proposal.operationId });
  assert.throws(() => f.validate(), /affected consenting member/); f.operations.pop();
  f.make('a', 'requestDecision', { requestId: request.operationId, decision: 'acceptCounteroffer', target: null, referenceDecisionId: proposal.operationId }); f.validate();
});
test('v2 receiver targets undo to the observed completion and recorder or historical administrator', async () => {
  const f = await fixture(); const work = f.complete('a'); f.validate();
  f.make('b', 'completion', { targetOperationId: work.operationId }, { entityId: work.entityId, operationType: 'undo' });
  assert.throws(() => f.validate(), /Only the recorder/); f.operations.pop();
  const undo = f.make('owner', 'completion', { targetOperationId: work.operationId }, { entityId: work.entityId, operationType: 'undo' }); f.validate();
  f.archive.push(transferSharedOwnership(f.archive.at(-1), f.identities.owner, { userId: 'b', deviceId: f.identities.b.deviceId }));
  f.validate(); assert.equal(undo.authorUserId, 'owner');
});
test('v2 receiver keeps each-member identities separate and rejects forged subjects, performers and original assignments', async () => {
  const f = await fixture('eachMember'); const a = f.complete('a', 'a', ['a']); const b = f.complete('b', 'b', ['b']); f.validate();
  assert.notEqual(a.entityId, b.entityId);
  f.complete('a', null, []); assert.throws(() => f.validate(), /subject/); f.operations.pop();
  f.complete('a', 'b', ['b'], 'b'); assert.throws(() => f.validate(), /another person/); f.operations.pop();
  f.complete('owner', 'a', ['owner'], 'a'); assert.throws(() => f.validate(), /Original assignees/);
});
test('v2 receiver refuses same-assignee fixed overlaps while allowing adjacent time slots, different assignees and date-only plans', async () => {
  for (const [member, target, denied] of [
    ['a', time('2026-10-27T01:30:00Z', '2026-10-27T02:30:00Z'), true],
    ['a', time('2026-10-27T02:00:00Z', '2026-10-27T03:00:00Z'), false],
    ['b', time('2026-10-27T01:30:00Z', '2026-10-27T02:30:00Z'), false], ['a', date(anchorDate), false],
  ]) {
    const f = await fixture('assigned', ['a']); f.designation('owner', time('2026-10-27T01:00:00Z', '2026-10-27T02:00:00Z'));
    f.make('owner', 'chore', { name: '別の家事', enabled: true }, { entityId: 'second' });
    f.make('owner', 'chorePolicy', { configuration: config('assigned', [member]) }, { entityId: 'second' });
    f.designation('owner', target, { choreId: 'second' });
    if (denied) assert.throws(() => f.validate(), /forbidden/); else f.validate();
  }
});
test('v2 receiver authenticates membership epochs and requires canonical occurrence IDs rather than client-supplied labels', async () => {
  const f = await fixture(); const claim = f.claim('a'); f.validate();
  const wrong = { ...claim, payload: { ...claim.payload, occurrenceId: 'made-up' } };
  assert.throws(() => f.validate([...f.operations.slice(0, -1), wrong]), /another common occurrence/);
  assert.throws(() => f.validate([...f.operations.slice(0, -1), { ...claim, authorDeviceId: f.identities.b.deviceId }]), /approved device/);
  assert.throws(() => f.validate([...f.operations.slice(0, -1), { ...claim, schemaVersion: 1, recordedAt: undefined } ]));
});
test('v2 common frames retain anchors and stable identities across horizons without personal inputs or virtual completion events', () => {
  const configuration = config(); const first = commonFrames(groupId, 'floor', configuration, anchorDate, '2026-12-31');
  const later = commonFrames(groupId, 'floor', configuration, '2026-11-01', '2026-12-31');
  assert.deepEqual(later, first.filter((frame) => frame.anchorDate >= '2026-11-01'));
  assert.equal(commonFrame(groupId, 'floor', { ...configuration, ruleVersion: 2 }, anchorDate).id, first[0].id);
  assert.throws(() => commonFrame(groupId, 'floor', configuration, '2026-10-28'));
});
test('v2 repeated designations keep the civil-day offset and wall clock across DST and retain one-off targets after a cycle revision', () => {
  const rule = { id: 'rule', choreId: 'floor', subjectUserId: null, referenceAnchorDate: '2026-03-03', timeZoneAtCreation: 'America/New_York', selector: { scope: 'ongoing', from: '2026-03-03' },
    mode: 'fixed', target: time('2026-03-04T00:00:00Z', '2026-03-04T01:00:00Z'), ruleVersion: 1 };
  const frame = { id: 'frame', choreId: 'floor', anchorDate: '2026-03-10', ruleVersion: 1 };
  assert.deepEqual(materializeRuleTarget(rule, frame, 'America/New_York'), { kind: 'target', target: time('2026-03-10T23:00:00.000Z', '2026-03-11T00:00:00.000Z') });
  assert.deepEqual(materializeRuleTarget(rule, { ...frame, ruleVersion: 2 }, 'America/New_York'), { kind: 'review', reason: 'cycleChanged' });
  const once = { ...rule, selector: { scope: 'once', occurrenceId: 'frame', anchorDate: frame.anchorDate } };
  assert.deepEqual(materializeRuleTarget(once, { ...frame, ruleVersion: 2 }, 'America/New_York'), { kind: 'target', target: time('2026-03-04T00:00:00.000Z', '2026-03-04T01:00:00.000Z') });
});
test('v2 authority history survives compaction including superseded grants and original completion reports', async () => {
  const f = await fixture('assigned', ['owner']);
  const rights = { choreId: 'floor', userId: 'a', enabled: true, rights: { changeDate: true, changeOthers: true, changeBeforeWindow: false } };
  f.make('owner', 'datePermission', rights, { entityId: v2DatePermissionId(groupId, 'floor', 'a') }); f.designation('a', date('2026-10-28'));
  f.make('owner', 'datePermission', { ...rights, enabled: false }, { entityId: v2DatePermissionId(groupId, 'floor', 'a') });
  f.validate(); const replica = buildSharedReplica(groupId, f.operations);
  validateV2BusinessHistory(buildSharedReplica(groupId, [], compactSharedReplica(replica)), f.archive);
});
test('v2 invalid received grants cannot authorize descendants and quarantine does not block unrelated edits or actual work', async () => {
  const f = await fixture('assigned', ['owner']);
  const forged = f.make('a', 'datePermission', { choreId: 'floor', userId: 'a', enabled: true,
    rights: { changeDate: true, changeOthers: true, changeBeforeWindow: true } }, { entityId: v2DatePermissionId(groupId, 'floor', 'a') });
  const attempted = f.designation('a', date('2026-10-28'));
  const independent = f.make('b', 'chore', { name: '床掃除の説明', instructions: ['用具を準備する'] }, { entityId: 'floor' });
  const work = f.complete('owner', null, ['owner']);
  for (const operations of [f.operations, [...f.operations].reverse()]) {
    const result = assessV2BusinessHistory(buildSharedReplica(groupId, operations), f.archive);
    assert.deepEqual(result.rejected.map((entry) => entry.operationId), [forged.operationId, attempted.operationId]);
    assert.equal(result.view.byId(forged.operationId), undefined);
    assert.equal(result.view.byId(attempted.operationId), undefined);
    assert.equal(result.view.byId(independent.operationId).payload.name, '床掃除の説明');
    assert.equal(result.view.byId(work.operationId).payload.outcome, 'completed');
  }
});
test('v2 receiver cannot clear an earlier prohibition at the same time and then bypass it with a second date edit', async () => {
  const f = await fixture('assigned', ['a']); const original = f.designation('owner', date(anchorDate), { forbidEarlier: true }); f.validate();
  f.designation('a', date(anchorDate)); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const request = f.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: original.operationId, original: date(anchorDate), proposed: date(anchorDate), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' });
  f.validate();
  const context = dateChangeContextAtOperation(createV2HistoryView(buildSharedReplica(groupId, f.operations)), f.archive, request);
  assert.deepEqual(context.permission, { kind: 'approvalRequired', approver: 'admin', reason: 'strict' });
});
test('v2 requests preserve explicit deadline meaning and cannot automatically downgrade a locked fixed time into an earlier deadline', async () => {
  const f = await fixture('assigned', ['a']);
  const request = f.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: null, original: date(anchorDate), proposed: date('2026-10-28'), proposedMode: 'deadline',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' });
  f.validate(); assert.equal(dateChangeContextAtOperation(createV2HistoryView(buildSharedReplica(groupId, f.operations)), f.archive, request).mode, 'deadline');
  const locked = await fixture('assigned', ['a']); const target = time('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z');
  const fixed = locked.designation('owner', target, { adminLocked: true });
  const change = locked.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: locked.occurrenceId, subjectUserId: null,
    originalDesignationId: fixed.operationId, original: target, proposed: { precision: 'instant', at: '2026-10-27T08:00:00Z' }, proposedMode: 'deadline',
    proposedOptions: { strict: false, adminLocked: true, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: locked.occurrenceId, anchorDate }, extensionScope: 'once' });
  locked.validate(); assert.deepEqual(dateChangeContextAtOperation(createV2HistoryView(buildSharedReplica(groupId, locked.operations)), locked.archive, change).permission,
    { kind: 'approvalRequired', approver: 'admin', reason: 'fixed' });
});
test('v2 clock rules bind their authoring group timezone and repeating rules request review after a timezone change', async () => {
  const f = await fixture('assigned', ['a']); const fact = f.designation('owner', time('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z'),
    { selector: { scope: 'ongoing', from: anchorDate } }); f.validate();
  const occurrence = { id: f.occurrenceId, choreId: 'floor', anchorDate, ruleVersion: 1 };
  assert.deepEqual(materializeRuleTarget(fact.payload.configuration, occurrence, 'America/New_York'), { kind: 'review', reason: 'timeZoneChanged' });
  const once = { ...fact.payload.configuration, selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate } };
  assert.equal(materializeRuleTarget(once, occurrence, 'America/New_York').kind, 'target');
  fact.payload.configuration.timeZoneAtCreation = 'UTC'; assert.throws(() => f.validate(), /group timezone/);
});

test('v2 administrator counteroffers cannot bypass another fixed shared chore for the same assignee', async () => {
  const f = await fixture('assigned', ['a']);
  const original = time('2026-10-27T01:00:00Z', '2026-10-27T02:00:00Z');
  const locked = f.designation('owner', original, { adminLocked: true });
  f.make('owner', 'chore', { name: '別の家事', enabled: true }, { entityId: 'second' });
  f.make('owner', 'chorePolicy', { configuration: config('assigned', ['a']) }, { entityId: 'second' });
  f.designation('owner', time('2026-10-27T03:00:00Z', '2026-10-27T04:00:00Z'), { choreId: 'second' });
  const request = f.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: locked.operationId, original, proposed: time('2026-10-27T05:00:00Z', '2026-10-27T06:00:00Z'), proposedMode: 'fixed',
    proposedOptions: { strict: false, adminLocked: true, forbidEarlier: false }, selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' });
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'counteroffer', target: time('2026-10-27T03:30:00Z', '2026-10-27T04:30:00Z'), referenceDecisionId: null });
  assert.throws(() => f.validate(), /Counteroffer conflicts/); f.operations.pop();
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'counteroffer', target: time('2026-10-27T04:00:00Z', '2026-10-27T05:00:00Z'), referenceDecisionId: null });
  f.validate();
});

test('v2 date conflict resolution observes every candidate and cannot silently resolve from an incomplete or lower-priority basis', async () => {
  const f = await fixture('assigned', ['a']); const base = [...f.operations];
  const first = f.designation('owner', date('2026-10-28'), { observed: base });
  const second = f.designation('a', date('2026-10-29'), { observed: base }); f.validate();
  f.designation('owner', date('2026-10-30'), { basisRuleIds: [first.operationId] });
  assert.throws(() => f.validate(), /every observed candidate/); f.operations.pop();
  f.designation('owner', date('2026-10-30'), { basisRuleIds: [first.operationId, second.operationId], selector: { scope: 'ongoing', from: anchorDate } });
  assert.throws(() => f.validate(), /lower-priority/); f.operations.pop();
  const resolved = f.designation('owner', date('2026-10-30'), { basisRuleIds: [first.operationId, second.operationId] }); f.validate();
  const probe = f.make('owner', 'member', { displayName: '管理者' }, { entityId: 'owner' });
  const context = dateChangeContextAtOperation(createV2HistoryView(buildSharedReplica(groupId, f.operations)), f.archive,
    { ...probe, entityType: 'changeRequest', payload: { choreId: 'floor', anchorDate, subjectUserId: null,
      originalDesignationId: resolved.operationId, original: date('2026-10-30'), proposed: date('2026-10-30'), proposedMode: 'day',
      proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, basisRuleIds: [resolved.operationId] } });
  assert.equal(context.originalRule.id, resolved.operationId);
});
test('v2 members resolving conflicting dates must request administrator approval and inherit every candidate instruction guard', async () => {
  const f = await fixture('assigned', ['a']); const base = [...f.operations];
  const first = f.designation('owner', date('2026-10-28'), { strict: true, forbidEarlier: true, observed: base });
  const second = f.designation('a', date('2026-10-29'), { observed: base });
  const basisRuleIds = [first.operationId, second.operationId];
  f.designation('a', date('2026-10-30'), { basisRuleIds }); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const request = f.make('a', 'changeRequest', { requesterUserId: 'a', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: null, original: date('2026-10-28'), proposed: date('2026-10-30'), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, basisRuleIds,
    selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' }); f.validate();
  const context = dateChangeContextAtOperation(createV2HistoryView(buildSharedReplica(groupId, f.operations)), f.archive, request);
  assert.equal(context.originalWasConflicted, true); assert.equal(context.originalOptions.strict, true); assert.equal(context.originalOptions.forbidEarlier, true);
  assert.deepEqual(context.permission, { kind: 'approvalRequired', approver: 'admin', reason: 'strict' });
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null }); f.validate();
});
test('v2 an administrator resolving roommate date conflicts still needs the affected assignee consent', async () => {
  const f = await fixture('assigned', ['a'], { ...createGroupPolicy('roommates'), delegationEnabled: true });
  f.make('owner', 'datePermission', { choreId: 'floor', userId: 'b', enabled: true,
    rights: { changeDate: true, changeOthers: true, changeBeforeWindow: false } }, { entityId: v2DatePermissionId(groupId, 'floor', 'b') });
  const base = [...f.operations]; const first = f.designation('a', date('2026-10-28'), { observed: base });
  const second = f.designation('b', date('2026-10-29'), { observed: base });
  const basisRuleIds = [first.operationId, second.operationId];
  f.designation('owner', date('2026-10-30'), { basisRuleIds }); assert.throws(() => f.validate(), /requires a signed request/); f.operations.pop();
  const request = f.make('owner', 'changeRequest', { requesterUserId: 'owner', choreId: 'floor', anchorDate, occurrenceId: f.occurrenceId, subjectUserId: null,
    originalDesignationId: null, original: date('2026-10-28'), proposed: date('2026-10-30'), proposedMode: 'day',
    proposedOptions: { strict: false, adminLocked: false, forbidEarlier: false }, basisRuleIds,
    selector: { scope: 'once', occurrenceId: f.occurrenceId, anchorDate }, extensionScope: 'once' }); f.validate();
  f.make('owner', 'requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null });
  assert.throws(() => f.validate(), /designated approver/); f.operations.pop();
  f.make('a', 'requestDecision', { requestId: request.operationId, decision: 'approve', target: null, referenceDecisionId: null }); f.validate();
});
test('v2 an administrator can cancel an explicitly observed conflict candidate without erasing the other candidate or history', async () => {
  const f = await fixture('assigned', ['a']); const base = [...f.operations];
  const first = f.designation('owner', date('2026-10-28'), { observed: base }); const second = f.designation('a', date('2026-10-29'), { observed: base });
  const undo = f.make('owner', 'designationCancel', { targetOperationIds: [second.operationId] }); f.validate();
  assert.ok(f.operations.includes(first)); assert.ok(f.operations.includes(second)); assert.equal(undo.payload.targetOperationIds.length, 1);
});
