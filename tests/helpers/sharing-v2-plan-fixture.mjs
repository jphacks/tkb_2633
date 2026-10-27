import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice } from '../../src/features/sharing/roster.ts';
import { buildSharedReplica } from '../../src/features/sharing/replica.ts';
import { createGroupPolicy, chorePolicyFromPreset } from '../../src/features/sharing/v2/model.ts';
import { v2AuthorProofDigest } from '../../src/features/sharing/v2/server-receipts.ts';
import { assessV2BusinessHistory } from '../../src/features/sharing/v2/receiver-authority.ts';
import { buildV2CommonPlan } from '../../src/features/sharing/v2/common-plan.ts';
import { v2OccurrenceId, v2SubjectOccurrenceId } from '../../src/features/sharing/v2/occurrence-id.ts';
import { v2ReadPoint } from '../../src/features/sharing/v2/view-point.ts';
import { recordedInstructionAt } from '../../src/features/sharing/v2/recorded-instruction.ts';
import { frameAtOperation } from '../../src/features/sharing/v2/authority-context.ts';
export const groupId = 'v2-plan-test';
export const anchorDate = '2026-10-27';
export const date = (value) => ({ precision: 'date', date: value });
export async function fixture({ preset = 'common', members = [], cycle = 7, before = 2, after = 2, kind = 'family', policy = {}, configuration = {} } = {}) {
  const identities = {};
  for (const device of ['owner', 'a', 'b', 'owner2']) identities[device] = await createDeviceIdentity(crypto);
  const uid = (device) => device === 'owner2' ? 'owner' : device;
  const archive = [createSharedRoster(groupId, 'owner', identities.owner, { schemaVersion: 2 })];
  for (const device of ['a', 'b', 'owner2']) archive.push(approveSharedDevice(archive.at(-1), identities.owner, uid(device), identities[device]));
  const facts = []; const receipts = new Map(); let sequence = 0;
  const defaultConfiguration = { policy: chorePolicyFromPreset(preset, members), anchorDate, intervalDays: cycle,
    windowBeforeDays: before, windowAfterDays: after, ruleVersion: 1, ...configuration };
  function make(entityType, payload, { actor = 'owner', entityId, operationType = 'patch', observed = facts.map((fact) => fact.operation), operationId,
    delivered = true, receivedAt = '2026-10-27T10:00:00Z', recordedAt = '2026-10-27T10:00:00Z' } = {}) {
    const context = {};
    for (const op of observed) {
      context[op.authorDeviceId] = Math.max(context[op.authorDeviceId] ?? 0, op.deviceSequence);
      for (const [id, count] of Object.entries(op.context)) context[id] = Math.max(context[id] ?? 0, count);
    }
    const id = operationId ?? `op-${String(facts.length + 1).padStart(5, '0')}`;
    const fact = signSharedOperation({ schemaVersion: 2, operationId: id, groupId, authorUserId: uid(actor), authorDeviceId: identities[actor].deviceId,
      keyVersion: archive.at(-1).body.keyVersion, deviceSequence: (context[identities[actor].deviceId] ?? 0) + 1,
      logicalClock: Math.max(0, ...observed.map((op) => op.logicalClock)) + 1, context, recordedAt,
      entityType, entityId: entityId ?? id, operationType, payload }, identities[actor]);
    facts.push(fact);
    if (delivered) receipts.set(id, { schemaVersion: 2, groupId, operationId: id, authorUserId: uid(actor), authorDeviceId: identities[actor].deviceId,
      receivedKeyVersion: archive.at(-1).body.keyVersion, uploadSequence: ++sequence, authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: Date.parse(receivedAt) });
    return fact.operation;
  }
  make('groupPolicy', { configuration: { ...createGroupPolicy(kind), ...policy } }, { entityId: 'policy' });
  make('settings', { name: 'テスト', timeZone: 'Asia/Tokyo', anchorDate }, { entityId: 'settings' });
  make('chore', { name: '床を掃除する', enabled: true, load: 'normal' }, { entityId: 'floor' });
  make('chorePolicy', { configuration: defaultConfiguration }, { entityId: 'floor' });
  function state(ordered = facts) {
    const replica = buildSharedReplica(groupId, ordered.map((fact) => fact.operation));
    const assessment = assessV2BusinessHistory(replica, archive, undefined, { receipts, facts: new Map(facts.map((fact) => [fact.operation.operationId, fact])),
      pendingLocalIds: new Set(facts.filter((fact) => !receipts.has(fact.operation.operationId)).map((fact) => fact.operation.operationId)) });
    return { assessment, replica, archive, receipts };
  }
  const range = { from: anchorDate, through: '2026-11-24', asOfDate: anchorDate };
  const plan = (override = {}, ordered) => buildV2CommonPlan(state(ordered), { ...range, ...override });
  const occurrence = (day = anchorDate) => v2OccurrenceId(groupId, 'floor', day);
  function designation(target, { actor = 'owner', subjectUserId = null, day = anchorDate, ...extra } = {}) {
    const id = `op-${String(facts.length + 1).padStart(5, '0')}`;
    const { observed, ...fields } = extra;
    return make('designation', { configuration: { id, choreId: 'floor', subjectUserId,
      selector: { scope: 'once', occurrenceId: occurrence(day), anchorDate: day }, referenceAnchorDate: day,
      timeZoneAtCreation: 'Asia/Tokyo', mode: target.precision === 'interval' ? 'fixed' : 'day', target,
      strict: false, adminLocked: false, forbidEarlier: false, issuerUserId: uid(actor), ruleVersion: 1, ...fields } }, { actor, ...(observed ? { observed } : {}) });
  }
  function complete({ actor = 'a', subject = null, day = anchorDate, performedAt = '2026-10-27T01:00:00Z', instruction = true, recordedAt, receivedAt, ...extra } = {}) {
    const s = state(); const at = v2ReadPoint(s.assessment.view, archive.at(-1));
    const context = frameAtOperation(s.assessment.view, archive, at, 'floor', day, extra.ruleVersion);
    const recordedInstruction = recordedInstructionAt(s.assessment.view, at, context.frame, subject, s.assessment.approvedRules);
    return make('completion', { choreId: 'floor', anchorDate: day, completedAt: performedAt, completedByMemberId: uid(actor), subjectUserId: subject,
      originalAssigneeIds: subject === null ? context.assigneeIds : [subject], ruleVersion: context.config.ruleVersion, outcome: 'completed',
      ...(instruction ? { recordedInstruction } : {}), ...extra }, { actor, recordedAt, receivedAt, entityId: v2SubjectOccurrenceId(occurrence(day), subject), operationType: 'complete' });
  }
  return { identities, archive, facts, receipts, make, state, plan, occurrence, designation, complete, defaultConfiguration };
}
