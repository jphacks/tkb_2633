import { sharingTestCrypto as crypto } from './sharing-crypto.mjs';
import { createDeviceIdentity, signSharedOperation } from '../../src/features/sharing/crypto.ts';
import { createSharedRoster, approveSharedDevice } from '../../src/features/sharing/roster.ts';
import { v2AuthorProofDigest } from '../../src/features/sharing/v2/server-receipts.ts';
import { deriveV2DateRequest } from '../../src/features/sharing/v2/request-state.ts';

export const start = Date.parse('2026-10-27T00:00:00Z'); export const hour = 3600000;
export const date = (date) => ({ precision: 'date', date });
export const instant = (offset) => ({ precision: 'instant', at: new Date(start + offset * hour).toISOString() });
const permission = { kind: 'approvalRequired', approver: 'admin', reason: 'fixed' };
export async function fixture({ mode = 'day', original = date('2026-10-30'), proposed = date('2026-10-31'), assigneeIds = ['a'], approval = permission } = {}) {
  const identities = {};
  for (const device of ['owner', 'a', 'b', 'a2', 'owner2']) identities[device] = await createDeviceIdentity(crypto);
  const uid = (device) => device.replace(/2$/u, '');
  const archive = [createSharedRoster('request-group', 'owner', identities.owner, { schemaVersion: 2 })];
  for (const device of ['a', 'b', 'a2', 'owner2']) archive.push(approveSharedDevice(archive.at(-1), identities.owner, uid(device), identities[device]));
  const receipts = new Map(); const decisions = []; let generated = 0; let uploadSequence = 0;
  const request = signSharedOperation({ schemaVersion: 2, operationId: 'request', groupId: 'request-group', authorUserId: 'a', authorDeviceId: identities.a.deviceId,
    keyVersion: archive.at(-1).body.keyVersion, deviceSequence: 1, logicalClock: 1, context: {}, receiptContext: {}, recordedAt: new Date(start).toISOString(),
    entityType: 'changeRequest', entityId: 'request', operationType: 'patch', payload: { requesterUserId: 'a', choreId: 'floor', anchorDate: '2026-10-30',
      occurrenceId: 'frame', subjectUserId: null, originalDesignationId: 'old-date', original, proposed, proposedMode: mode,
      proposedOptions: { strict: true, adminLocked: true, forbidEarlier: false },
      selector: { scope: 'once', occurrenceId: 'frame', anchorDate: '2026-10-30' }, extensionScope: 'once' } }, identities.a);
  function deliver(fact, at = start, receivedKeyVersion = archive.at(-1).body.keyVersion) {
    const op = fact.operation; const receipt = { schemaVersion: 2, groupId: op.groupId, operationId: op.operationId,
      authorUserId: op.authorUserId, authorDeviceId: op.authorDeviceId, receivedKeyVersion, uploadSequence: ++uploadSequence,
      authorProofDigest: v2AuthorProofDigest(fact), receivedAtMs: at };
    receipts.set(op.operationId, receipt); return receipt;
  }
  deliver(request);
  function decide(device, decision, { observed = [request, ...decisions], target = null, referenceDecisionId = null, at = start + 1000, delivered = true, allowDuringCooldown } = {}) {
    const context = {};
    for (const fact of observed) {
      const op = fact.operation;
      context[op.authorDeviceId] = Math.max(context[op.authorDeviceId] ?? 0, op.deviceSequence);
      for (const [id, value] of Object.entries(op.context)) context[id] = Math.max(context[id] ?? 0, value);
    }
    const receiptContext = {};
    for (const fact of observed) { const op = fact.operation; if (receipts.has(op.operationId)) receiptContext[op.authorDeviceId] = Math.max(receiptContext[op.authorDeviceId] ?? 0, op.deviceSequence); }
    const operationId = `decision-${String(++generated).padStart(4, '0')}`;
    const fact = signSharedOperation({ schemaVersion: 2, operationId, groupId: 'request-group', authorUserId: uid(device), authorDeviceId: identities[device].deviceId,
      keyVersion: archive.at(-1).body.keyVersion, deviceSequence: (context[identities[device].deviceId] ?? 0) + 1,
      logicalClock: Math.max(0, ...observed.map((fact) => fact.operation.logicalClock)) + 1, context, receiptContext,
      recordedAt: new Date(start + 500).toISOString(), entityType: 'requestDecision', entityId: operationId, operationType: 'patch',
      payload: { requestId: 'request', decision, target, referenceDecisionId, ...(allowDuringCooldown === undefined ? {} : { allowDuringCooldown }) } }, identities[device]);
    decisions.push(fact); if (delivered) deliver(fact, at); return fact;
  }
  const state = (extra = {}) => deriveV2DateRequest({ request, decisions, receipts, archive, context: { permission: approval, assigneeIds, timeZone: 'Asia/Tokyo' }, ...extra });
  return { request, identities, archive, decisions, receipts, state, decide, deliver };
}

