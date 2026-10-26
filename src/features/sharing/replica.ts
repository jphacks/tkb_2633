import { canonicalJson, causallyPrecedes, compareOperationIds, validateSharedOperation } from './operations.ts';
import type { JsonValue, SharedEntityType, SharedOperation, VersionVector } from './operations.ts';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

export interface SharedOperationReceipt { operationId: string; deviceId: string; sequence: number; digest: string }
export interface SharedSnapshotBase {
  groupId: string;
  frontier: VersionVector;
  logicalClock: number;
  /** Compact receipts retain ID/dot collision detection after discarded edits are removed. */
  operationIndex: SharedOperationReceipt[];
  operations: SharedOperation[];
}

export interface FieldCandidate { operationId: string; value: JsonValue }
export interface SharedEntity {
  entityType: SharedEntityType;
  entityId: string;
  deleted: boolean;
  fields: Record<string, JsonValue>;
  conflicts: Record<string, FieldCandidate[]>;
  revisions: Record<string, string[]>;
}
export interface EffectiveCompletion {
  occurrenceId: string;
  operationId: string;
  /** All independent completions remain available for targeted undo and audit. */
  activeOperationIds: string[];
  payload: Record<string, JsonValue>;
}
export interface SharedReplica {
  groupId: string;
  operations: SharedOperation[];
  entities: SharedEntity[];
  completions: EffectiveCompletion[];
  frontier: VersionVector;
  logicalClock: number;
  pendingOperationIds: string[];
  operationIndex: SharedOperationReceipt[];
}

export function sharedOperationDigest(operation: SharedOperation): string {
  return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(operation))));
}

function receipt(operation: SharedOperation): SharedOperationReceipt {
  return { operationId: operation.operationId, deviceId: operation.authorDeviceId,
    sequence: operation.deviceSequence, digest: sharedOperationDigest(operation) };
}

export function validateSharedSnapshotBase(groupId: string, base: SharedSnapshotBase): SharedSnapshotBase {
  if (base.groupId !== groupId || !Number.isSafeInteger(base.logicalClock) || base.logicalClock < 0
    || !Array.isArray(base.operationIndex) || !Array.isArray(base.operations)) throw new Error('Invalid shared snapshot base');
  const ids = new Set<string>(); const dots = new Set<string>();
  let expected = 0;
  for (const [device, count] of Object.entries(base.frontier)) {
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/u.test(device) || !Number.isSafeInteger(count) || count < 0 || count > base.logicalClock) throw new Error('Invalid snapshot causal frontier');
    expected += count;
  }
  if (Object.keys(base.frontier).length > 256 || !Number.isSafeInteger(expected) || expected !== base.operationIndex.length) throw new Error('Snapshot receipt history is incomplete');
  const byId = new Map<string, SharedOperationReceipt>();
  for (const item of base.operationIndex) {
    if (!/^[A-Za-z0-9_.:@-]{1,200}$/u.test(item.operationId) || !Number.isSafeInteger(item.sequence) || item.sequence < 1
      || item.sequence > (base.frontier[item.deviceId] ?? 0) || !/^[a-f0-9]{64}$/u.test(item.digest)) throw new Error('Invalid snapshot operation receipt');
    const dot = `${item.deviceId}:${item.sequence}`;
    if (ids.has(item.operationId) || dots.has(dot)) throw new Error('Snapshot reused an operation ID or device sequence');
    ids.add(item.operationId); dots.add(dot); byId.set(item.operationId, item);
  }
  const retained = new Set<string>();
  for (const raw of base.operations) {
    const op = validateSharedOperation(raw, groupId); const entry = byId.get(op.operationId);
    if (retained.has(op.operationId) || !entry || entry.deviceId !== op.authorDeviceId || entry.sequence !== op.deviceSequence
      || entry.digest !== sharedOperationDigest(op) || op.logicalClock > base.logicalClock
      || Object.entries(op.context).some(([device, count]) => count > (base.frontier[device] ?? 0))) throw new Error('Snapshot fact does not match its causal receipt');
    retained.add(op.operationId);
  }
  return base;
}

function candidates(operations: SharedOperation[], field: string): FieldCandidate[] {
  const writing = operations.filter((op) => field === '$alive' || Object.hasOwn(op.payload, field));
  const latestByDevice = new Map<string, SharedOperation>();
  for (const op of writing) {
    if ((latestByDevice.get(op.authorDeviceId)?.deviceSequence ?? 0) < op.deviceSequence) latestByDevice.set(op.authorDeviceId, op);
  }
  const latest = [...latestByDevice.values()];
  return latest.filter((op) => !latest.some((other) => other !== op && causallyPrecedes(op, other)))
    .map((op) => ({ operationId: op.operationId, value: field === '$alive' ? op.operationType !== 'delete' : op.payload[field] }))
    .sort((a, b) => compareOperationIds(a.operationId, b.operationId));
}

/** Rebuild from facts, not arrival order. Only signature-verified operations may reach this function. */
export function buildSharedReplica(groupId: string, input: readonly SharedOperation[], snapshot?: SharedSnapshotBase): SharedReplica {
  const base = snapshot ? validateSharedSnapshotBase(groupId, snapshot) : undefined;
  const past = new Map(base?.operationIndex.map((entry) => [entry.operationId, entry]));
  const index = new Map(past);
  const byId = new Map<string, SharedOperation>();
  const byDot = new Map<string, string>();
  const baseIds = new Set(base?.operations.map((op) => op.operationId));
  for (const raw of [...(base?.operations ?? []), ...input]) {
    const op = validateSharedOperation(raw, groupId);
    const old = past.get(op.operationId);
    if (old && (old.deviceId !== op.authorDeviceId || old.sequence !== op.deviceSequence
      || old.digest !== sharedOperationDigest(op))) throw new Error('Operation ID reused after compaction');
    if (op.deviceSequence <= (base?.frontier[op.authorDeviceId] ?? 0)) {
      if (!old) throw new Error('Device sequence reused after compaction');
      if (!baseIds.has(op.operationId)) continue;
    }
    const previous = byId.get(op.operationId);
    if (previous && canonicalJson(previous) !== canonicalJson(op)) throw new Error('Operation ID reused with different content');
    const dot = `${op.authorDeviceId}:${op.deviceSequence}`;
    if (byDot.has(dot) && byDot.get(dot) !== op.operationId) throw new Error('Device sequence reused');
    byDot.set(dot, op.operationId); byId.set(op.operationId, op);
    if (!index.has(op.operationId)) index.set(op.operationId, receipt(op));
  }
  const operations = [...byId.values()].sort((a, b) => compareOperationIds(a.operationId, b.operationId));
  const deviceOperations = new Map<string, SharedOperation[]>();
  for (const op of operations) {
    const own = deviceOperations.get(op.authorDeviceId) ?? [];
    own.push(op); deviceOperations.set(op.authorDeviceId, own);
  }
  const causalClocks = new Map<string, { sequences: number[]; clocks: number[]; operations: SharedOperation[] }>();
  for (const [device, own] of deviceOperations) {
    own.sort((a, b) => a.deviceSequence - b.deviceSequence);
    let maximum = 0;
    causalClocks.set(device, { operations: own, sequences: own.map((op) => op.deviceSequence), clocks: own.map((op) => {
      maximum = Math.max(maximum, op.logicalClock); return maximum;
    }) });
  }
  // A cycle or backward Lamport clock is invalid. Indexed lookup keeps large histories off O(n²).
  for (const op of operations) {
    for (const [device, count] of Object.entries(op.context)) {
      const index = causalClocks.get(device);
      if (!index) continue;
      let low = 0; let high = index.sequences.length;
      while (low < high) {
        const middle = Math.floor((low + high) / 2);
        if (index.sequences[middle] <= count) low = middle + 1;
        else high = middle;
      }
      if (low && index.clocks[low - 1] >= op.logicalClock) throw new Error('Causal cycle or backward logical clock');
      if (low && Object.entries(index.operations[low - 1].context).some(([ancestor, sequence]) => (op.context[ancestor] ?? 0) < sequence)) {
        throw new Error('Causal context is not transitive');
      }
    }
  }
  const frontier: VersionVector = { ...Object.fromEntries([...deviceOperations.keys()].map((device) => [device, 0])), ...base?.frontier };
  const ready: SharedOperation[] = [];
  // Only causally complete operations become observed. A later dot cannot acknowledge a
  // hole, nor can it make another device's descendants of that hole visible prematurely.
  for (const op of [...operations].sort((a, b) => a.logicalClock - b.logicalClock || compareOperationIds(a.operationId, b.operationId))) {
    if (baseIds.has(op.operationId)) { ready.push(op); continue; }
    if (op.deviceSequence !== (frontier[op.authorDeviceId] ?? 0) + 1
      || !Object.entries(op.context).every(([device, count]) => (frontier[device] ?? 0) >= count)) continue;
    ready.push(op); frontier[op.authorDeviceId] = op.deviceSequence;
  }
  const readyIds = new Set(ready.map((op) => op.operationId));
  const grouped = new Map<string, SharedOperation[]>();
  const completions = new Map<string, SharedOperation[]>();
  const undone = new Map<string, SharedOperation[]>();
  for (const op of ready) {
    if (op.entityType === 'completion') {
      const map = op.operationType === 'undo' ? undone : completions;
      const id = op.operationType === 'undo' ? op.payload.targetOperationId as string : op.entityId;
      const list = map.get(id) ?? []; list.push(op); map.set(id, list);
    } else {
      const key = `${op.entityType}:${op.entityId}`;
      const list = grouped.get(key) ?? []; list.push(op); grouped.set(key, list);
    }
  }
  for (const undo of ready.filter((op) => op.operationType === 'undo')) {
    const target = byId.get(undo.payload.targetOperationId as string);
    if (!target || target.entityType !== 'completion' || target.operationType !== 'complete'
      || target.entityId !== undo.entityId || !causallyPrecedes(target, undo)) {
      throw new Error('Undo does not observe its target completion');
    }
  }
  const entities: SharedEntity[] = [...grouped.entries()].sort(([a], [b]) => compareOperationIds(a, b)).map(([, ops]) => {
    const fields: Record<string, JsonValue> = {};
    const conflicts: Record<string, FieldCandidate[]> = {};
    const revisions: Record<string, string[]> = {};
    for (const field of ['$alive', ...new Set(ops.flatMap((op) => Object.keys(op.payload)))].sort()) {
      const values = candidates(ops, field);
      revisions[field] = values.map((item) => item.operationId);
      const distinct = new Set(values.map((item) => canonicalJson(item.value)));
      if (distinct.size > 1) conflicts[field] = values;
      else if (values.length) fields[field] = values[0].value;
    }
    // Ambiguous settings are omitted; callers must surface/resolve them before scheduling.
    const deleted = fields.$alive === false || Boolean(conflicts.$alive);
    delete fields.$alive;
    return { entityType: ops[0].entityType, entityId: ops[0].entityId, fields, conflicts, revisions, deleted };
  });
  const effective: EffectiveCompletion[] = [];
  for (const [occurrenceId, ops] of completions) {
    const active = ops.filter((op) => !undone.has(op.operationId)).sort((a, b) => compareOperationIds(a.operationId, b.operationId));
    const completed = active.filter((op) => op.payload.outcome === 'completed');
    const chosen = completed[0] ?? active[0];
    if (chosen) effective.push({ occurrenceId, operationId: chosen.operationId,
      activeOperationIds: active.map((op) => op.operationId), payload: chosen.payload });
  }
  effective.sort((a, b) => compareOperationIds(a.occurrenceId, b.occurrenceId));
  return { groupId, operations, entities, completions: effective, frontier,
    logicalClock: operations.reduce((max, op) => Math.max(max, op.logicalClock), base?.logicalClock ?? 0),
    pendingOperationIds: operations.filter((op) => !readyIds.has(op.operationId)).map((op) => op.operationId),
    operationIndex: [...index.values()].sort((a, b) => compareOperationIds(a.operationId, b.operationId)) };
}

/** Keep current field candidates, tombstones, audit history and each device's causal checkpoint. */
export function compactSharedReplica(replica: SharedReplica): SharedSnapshotBase {
  if (replica.pendingOperationIds.length) throw new Error('Cannot compact a causally incomplete shared history');
  const retained = new Set(replica.entities.flatMap((entity) => Object.values(entity.revisions).flat()));
  const last = new Map<string, SharedOperation>();
  for (const op of replica.operations) {
    if (op.entityType === 'completion') retained.add(op.operationId);
    if ((last.get(op.authorDeviceId)?.deviceSequence ?? 0) < op.deviceSequence) last.set(op.authorDeviceId, op);
  }
  for (const op of last.values()) retained.add(op.operationId);
  return validateSharedSnapshotBase(replica.groupId, { groupId: replica.groupId, frontier: { ...replica.frontier },
    logicalClock: replica.logicalClock, operationIndex: replica.operationIndex.map((item) => ({ ...item })),
    operations: replica.operations.filter((op) => retained.has(op.operationId)) });
}
