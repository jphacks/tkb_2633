import './helpers/typescript-loader.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { createGroupPolicy, changeGroupKind, chorePolicyFromPreset } from '../src/features/sharing/v2/model.ts';
import { normalizeDateTarget, validateDesignationTarget, targetReferenceTime, fixedAssignmentsOverlap } from '../src/features/sharing/v2/date-target.ts';
import { approvalDeadline, approvalDeliveryState } from '../src/features/sharing/v2/approval-deadline.ts';
import { subtractCivilRange, finiteValidity, selectManualRule } from '../src/features/sharing/v2/period-rules.ts';
import { checkPrivateCalendarConflict, validatedPrivateBusyIntervals } from '../src/features/sharing/v2/private-availability.ts';
import { proposePersonalRelocation } from '../src/features/sharing/v2/personal-relocation.ts';

const hour = 3600_000; const requestedAt = Date.parse('2026-10-27T00:00:00Z');
const instant = (at) => ({ precision: 'instant', at: new Date(at).toISOString() });
const date = (value) => ({ precision: 'date', date: value });
const interval = (start, end) => ({ precision: 'interval', start, end });
const occurrence = { id: 'occurrence-a', choreId: 'chore-a', anchorDate: '2026-10-27', windowStart: '2026-10-25', windowEnd: '2026-10-29', ruleVersion: 1 };
function rule(operationId, target, selector = { scope: 'ongoing', from: '2026-01-01' }, clock = {}) {
  return { operationId, authorDeviceId: operationId, deviceSequence: 1, context: {}, ...clock,
    rule: { id: operationId, choreId: 'chore-a', subjectUserId: null, selector, referenceAnchorDate: '2026-10-27', mode: 'day', target,
      strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: 'owner', ruleVersion: 1 } };
}

test('v2 family and roommate defaults are independent and switching kinds preserves every explicit setting', () => {
  const family = createGroupPolicy('family'); const roommates = createGroupPolicy('roommates');
  assert.equal(family.delegationEnabled, true); assert.equal(roommates.delegationEnabled, false);
  assert.equal(family.allowAfterWindow, false); assert.equal(roommates.allowAfterWindow, true);
  assert.equal(family.adminCanFixWithoutConsent, true); assert.equal(roommates.adminCanFixWithoutConsent, false);
  for (const policy of [family, roommates]) {
    assert.equal(policy.allowBeforeWindow, true); assert.equal(policy.allowSubstitution, true);
    assert.equal(policy.showCompletionStatus, true); assert.equal(policy.completionPushEnabled, false);
  }
  const customized = { ...family, completionPushEnabled: true, showCompletionStatus: false, allowSubstitution: false, delegationEnabled: false };
  assert.deepEqual(changeGroupKind(customized, 'roommates'), { ...customized, kind: 'roommates' });
  assert.equal(customized.kind, 'family');
  assert.throws(() => createGroupPolicy('unknown'));
});

test('v2 shared chore presets use orthogonal completion and assignment and never encode a private chore into a shared policy', () => {
  assert.deepEqual(chorePolicyFromPreset('common'), { completion: 'one', assignment: { mode: 'open', memberIds: [] } });
  assert.deepEqual(chorePolicyFromPreset('eachMember'), { completion: 'perMember', assignment: { mode: 'all', memberIds: [] } });
  assert.deepEqual(chorePolicyFromPreset('assigned', ['b', 'a']), { completion: 'one', assignment: { mode: 'selected', memberIds: ['a', 'b'] } });
  assert.throws(() => chorePolicyFromPreset('assigned', []));
  assert.throws(() => chorePolicyFromPreset('personal'));
});

test('v2 date, deadline instant and fixed intervals reject ambiguous or malformed timestamps without inventing a duration', () => {
  assert.deepEqual(normalizeDateTarget(date('2026-10-27')), date('2026-10-27'));
  assert.deepEqual(normalizeDateTarget({ precision: 'instant', at: '2026-10-27T09:00:00+09:00' }), instant(requestedAt));
  assert.equal(validateDesignationTarget('deadline', instant(requestedAt)).precision, 'instant');
  assert.equal(validateDesignationTarget('fixed', interval('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z')).precision, 'interval');
  for (const target of [date('2026-02-30'), { precision: 'instant', at: '2026-10-27T10:00:00' },
    { precision: 'instant', at: '2026-10-27T24:00:00Z' }, { precision: 'instant', at: '2026-02-30T10:00:00Z' },
    { precision: 'instant', at: '2026-10-27T10:00:60Z' }, { precision: 'instant', at: '2026-10-27T10:00:00+09:99' },
    interval('2026-10-27T10:00:00Z', '2026-10-27T10:00:00Z'), { precision: 'date', date: '2026-10-27', extra: true }]) assert.throws(() => normalizeDateTarget(target));
  assert.throws(() => validateDesignationTarget('fixed', instant(requestedAt)));
  assert.throws(() => validateDesignationTarget('day', interval('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z')));
});

test('v2 fixed time conflicts require both an overlapping interval and a shared assignee', () => {
  const first = { target: interval('2026-10-27T09:00:00Z', '2026-10-27T10:00:00Z'), assigneeIds: ['member-a', 'member-b'] };
  const adjacent = { target: interval('2026-10-27T10:00:00Z', '2026-10-27T11:00:00Z'), assigneeIds: ['member-a'] };
  const overlapping = { target: interval('2026-10-27T09:30:00Z', '2026-10-27T11:00:00Z'), assigneeIds: ['member-b'] };
  assert.equal(fixedAssignmentsOverlap(first, adjacent), false);
  assert.equal(fixedAssignmentsOverlap(first, overlapping), true);
  assert.equal(fixedAssignmentsOverlap(first, { ...overlapping, assigneeIds: ['other-member'] }), false);
  assert.equal(fixedAssignmentsOverlap(first, { target: date('2026-10-27'), assigneeIds: ['member-a'] }), false);
});

test('v2 approval grace handles every threshold including one millisecond boundaries using server receipts', () => {
  const rows = [[36, 24, 12], [24, 12, 6], [12, 6, 3], [6, 3, 1], [1, 1, null]];
  for (const [remaining, above, at] of rows) for (const offset of [-1, 0, 1]) {
    const target = instant(requestedAt + remaining * hour + offset);
    const result = approvalDeadline({ serverRequestedAt: requestedAt, original: target, proposed: target, timeZone: 'Asia/Tokyo' });
    const expected = offset > 0 ? above : at;
    if (expected === null) assert.equal(result.kind, 'tooLate');
    else {
      assert.equal(result.kind, 'open'); assert.equal(result.graceHours, expected);
      assert.equal(result.expiresAt, Math.min(requestedAt + expected * hour, requestedAt + remaining * hour + offset - hour));
    }
  }
});

test('v2 date-only approval references group 23:59 and an earlier proposal never extends its available time', () => {
  assert.equal(targetReferenceTime(date('2026-10-27'), 'Asia/Tokyo'), Date.parse('2026-10-27T14:59:00Z'));
  assert.equal(targetReferenceTime(date('2026-11-01'), 'America/New_York'), Date.parse('2026-11-02T04:59:00Z'));
  const result = approvalDeadline({ serverRequestedAt: requestedAt, original: instant(requestedAt + 50 * hour),
    proposed: instant(requestedAt + 4 * hour), timeZone: 'Asia/Tokyo' });
  assert.equal(result.graceHours, 1); assert.equal(result.referenceAt, requestedAt + 4 * hour);
  assert.equal(approvalDeadline({ serverRequestedAt: null, original: date('2026-01-01'), proposed: date('2026-01-01'), timeZone: 'Asia/Tokyo' }).kind, 'pendingDelivery');
});

test('v2 late offline decisions expire while timely server-accepted decisions remain accepted when read much later', () => {
  const target = instant(requestedAt + 8 * hour);
  const deadline = approvalDeadline({ serverRequestedAt: requestedAt, original: target, proposed: target, timeZone: 'UTC' });
  assert.equal(approvalDeliveryState(deadline, null, requestedAt), 'awaiting');
  assert.equal(approvalDeliveryState(deadline, null, deadline.expiresAt + 1), 'expired');
  assert.equal(approvalDeliveryState(deadline, deadline.expiresAt + 1, requestedAt), 'expired');
  assert.equal(approvalDeliveryState(deadline, deadline.expiresAt, deadline.expiresAt + 365 * 24 * hour), 'accepted');
  assert.throws(() => approvalDeliveryState(deadline, requestedAt - 1, requestedAt));
  assert.equal(approvalDeliveryState({ kind: 'pendingDelivery' }, null, requestedAt), 'pendingDelivery');
});

test('v2 period replacement preserves both sides and handles disjoint, boundary and ongoing ranges', () => {
  const old = { from: '2026-10-01', through: '2026-10-31' };
  assert.deepEqual(subtractCivilRange(old, { from: '2026-10-10', through: '2026-10-20' }), [
    { from: '2026-10-01', through: '2026-10-09' }, { from: '2026-10-21', through: '2026-10-31' }]);
  assert.deepEqual(subtractCivilRange(old, { from: '2026-10-31', through: null }), [{ from: '2026-10-01', through: '2026-10-30' }]);
  assert.deepEqual(subtractCivilRange(old, { from: '2026-09-01', through: null }), []);
  assert.deepEqual(subtractCivilRange(old, { from: '2026-11-01', through: null }), [old]);
  assert.deepEqual(subtractCivilRange({ ...old, through: null }, { from: '2026-10-10', through: '2026-10-20' }), [
    { from: '2026-10-01', through: '2026-10-09' }, { from: '2026-10-21', through: null }]);
  assert.deepEqual(subtractCivilRange(old, old), []);
  assert.throws(() => subtractCivilRange(old, { from: '2026-10-20', through: '2026-10-10' }));
});

test('v2 two-week and calendar-month validity have explicit inclusive endings rather than assuming thirty days', () => {
  assert.deepEqual(finiteValidity('2026-10-27', 'twoWeeks'), { from: '2026-10-27', through: '2026-11-09' });
  assert.deepEqual(finiteValidity('2026-10-27', 'oneMonth'), { from: '2026-10-27', through: '2026-11-26' });
  assert.deepEqual(finiteValidity('2028-01-31', 'oneMonth'), { from: '2028-01-31', through: '2028-02-28' });
  assert.deepEqual(finiteValidity('2026-10-27', 'endDate', '2026-10-29'), { from: '2026-10-27', through: '2026-10-29' });
});

test('v2 manual rule priority and causal replacement preserve old ranges and independent same-time edits as conflicts', () => {
  const ongoing = rule('ongoing', date('2026-10-27'));
  const period = rule('period', date('2026-10-28'), { scope: 'period', range: { from: '2026-10-20', through: '2026-11-01' } });
  const once = rule('once', date('2026-10-29'), { scope: 'once', occurrenceId: occurrence.id, anchorDate: occurrence.anchorDate });
  assert.equal(selectManualRule([ongoing, period, once], occurrence, null).fact.operationId, 'once');
  assert.equal(selectManualRule([period, ongoing], occurrence, null).fact.operationId, 'period');
  const later = rule('later', date('2026-10-30'), period.rule.selector, { context: { period: 1 } });
  assert.equal(selectManualRule([ongoing, later, period], occurrence, null).fact.operationId, 'later');
  assert.equal(selectManualRule([ongoing, later, period], { ...occurrence, anchorDate: '2026-11-10' }, null).fact.operationId, 'ongoing');
  const concurrent = rule('concurrent', date('2026-10-26'), period.rule.selector);
  for (const facts of [[period, concurrent], [concurrent, period]]) {
    assert.deepEqual(selectManualRule(facts, occurrence, null).candidates.map((item) => item.operationId), ['concurrent', 'period']);
  }
  assert.equal(selectManualRule([once], occurrence, 'another-subject').kind, 'automatic');
});

test('v2 duplicate rule delivery is idempotent and reused operation IDs with different content are rejected', () => {
  const first = rule('rule-a', date('2026-10-27'));
  assert.deepEqual(selectManualRule([first, structuredClone(first), first], occurrence, null), selectManualRule([first], occurrence, null));
  assert.throws(() => selectManualRule([first, { ...first, rule: { ...first.rule, target: date('2026-10-28') } }], occurrence, null));
});

function busyCache() {
  return { ownerUserId: 'member-a', accountGeneration: 'account-a', mainDeviceId: 'main-a', mainRevision: 1, calendarBinding: 'calendar-a',
    timeZone: 'UTC',
    fetchedAt: '2026-10-27T00:00:00Z', coverage: { start: '2026-10-27T00:00:00Z', end: '2026-10-29T00:00:00Z' },
    intervals: [{ start: '2026-10-27T09:00:00Z', end: '2026-10-27T10:00:00Z' }] };
}
test('v2 private Calendar reports only a scoped conflict result and never treats stale, incomplete or foreign data as free', () => {
  const cache = busyCache(); const { fetchedAt: _fetched, coverage: _coverage, intervals: _intervals, ...binding } = cache;
  const target = interval('2026-10-27T09:30:00Z', '2026-10-27T10:30:00Z');
  assert.deepEqual(checkPrivateCalendarConflict(cache, binding, target, requestedAt), { kind: 'conflict' });
  assert.deepEqual(checkPrivateCalendarConflict(cache, binding, interval('2026-10-27T10:00:00Z', '2026-10-27T11:00:00Z'), requestedAt), { kind: 'clear' });
  for (const key of ['ownerUserId', 'accountGeneration', 'mainDeviceId', 'calendarBinding', 'mainRevision']) {
    assert.equal(checkPrivateCalendarConflict(cache, { ...binding, [key]: key === 'mainRevision' ? 2 : 'another' }, target, requestedAt).kind, 'unknown');
  }
  assert.equal(checkPrivateCalendarConflict(null, binding, target, requestedAt).kind, 'unknown');
  assert.equal(checkPrivateCalendarConflict(cache, binding, target, requestedAt + 36 * hour + 1).kind, 'unknown');
  assert.equal(checkPrivateCalendarConflict({ ...cache, fetchedAt: '2026-10-28T00:00:00Z' }, binding, target, requestedAt).kind, 'unknown');
  assert.equal(checkPrivateCalendarConflict(cache, binding, interval('2026-10-28T23:00:00Z', '2026-10-29T01:00:00Z'), requestedAt).kind, 'unknown');
  assert.equal(checkPrivateCalendarConflict(cache, binding, date('2026-10-27'), requestedAt).kind, 'unknown');
  assert.equal(checkPrivateCalendarConflict({ ...cache, intervals: [{ start: 'bad', end: 'bad' }] }, binding, target, requestedAt).kind, 'unknown');
});
test('v2 private Calendar clips and merges busy intervals without modifying its original cache', () => {
  const cache = busyCache(); const original = structuredClone(cache);
  cache.intervals.push({ start: '2026-10-27T09:45:00Z', end: '2026-10-27T11:00:00Z' },
    { start: '2026-10-26T23:00:00Z', end: '2026-10-27T01:00:00Z' });
  const before = structuredClone(cache);
  assert.deepEqual(validatedPrivateBusyIntervals(cache), [
    { start: requestedAt, end: requestedAt + hour }, { start: requestedAt + 9 * hour, end: requestedAt + 11 * hour }]);
  assert.deepEqual(cache, before); assert.equal(original.intervals.length, 1);
});
function relocation() {
  return { groupKind: 'family', fromGroupAdmin: true, personConsented: false,
    automatic: true, manuallyFixed: false, completed: false,
    original: { start: requestedAt + 9 * hour, end: requestedAt + 10 * hour },
    sharedFixed: { start: requestedAt + 9 * hour, end: requestedAt + 10 * hour },
    windowStart: '2026-10-27', windowEnd: '2026-10-28', timeZone: 'UTC',
    allowedWindows: [{ start: requestedAt + 8 * hour, end: requestedAt + 12 * hour }],
    fixedAndBusyIntervals: [{ start: requestedAt + 8 * hour, end: requestedAt + 9 * hour }], calendarConfirmed: true, now: requestedAt };
}
test('v2 private relocation obeys explicit allowed times, protects fixed chores and requires roommate consent', () => {
  const input = relocation(); const before = structuredClone(input);
  assert.deepEqual(proposePersonalRelocation(input), { kind: 'moved', original: input.original,
    proposed: { start: requestedAt + 10 * hour, end: requestedAt + 11 * hour }, reason: 'sharedFixedConflict' });
  assert.deepEqual(input, before);
  for (const patch of [{ manuallyFixed: true }, { automatic: false }, { completed: true }]) assert.equal(proposePersonalRelocation({ ...input, ...patch }).kind, 'protected');
  assert.equal(proposePersonalRelocation({ ...input, allowedWindows: [] }).reason, 'missingAllowedTimes');
  assert.equal(proposePersonalRelocation({ ...input, calendarConfirmed: false }).reason, 'unconfirmedCalendar');
  assert.equal(proposePersonalRelocation({ ...input, groupKind: 'roommates' }).kind, 'requiresConsent');
  assert.equal(proposePersonalRelocation({ ...input, groupKind: 'roommates', personConsented: true }).kind, 'moved');
  assert.equal(proposePersonalRelocation({ ...input, fromGroupAdmin: false }).kind, 'requiresConsent');
});
test('v2 private relocation searches the original civil day first even when earlier allowed windows exist', () => {
  const input = relocation();
  input.original = { start: requestedAt + 33 * hour, end: requestedAt + 34 * hour };
  input.sharedFixed = { ...input.original };
  input.allowedWindows.push({ start: requestedAt + 32 * hour, end: requestedAt + 36 * hour });
  const result = proposePersonalRelocation(input);
  assert.deepEqual(result.proposed, { start: requestedAt + 32 * hour, end: requestedAt + 33 * hour });
  assert.equal(proposePersonalRelocation({ ...input, fixedAndBusyIntervals: [{ start: requestedAt, end: requestedAt + 48 * hour }] }).reason, 'noSlot');
});
