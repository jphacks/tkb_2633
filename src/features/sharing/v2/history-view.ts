import { canonicalJson, causallyPrecedes } from '../operations.ts';
import type { JsonValue, SharedEntityType, SharedOperation } from '../operations.ts';
import type { SharedReplica } from '../replica.ts';
import { maximalCausalFacts } from './causal-facts.ts';

export class V2HistoryConflictError extends Error { readonly code = 'sharing/v2-history-conflict'; }

/** Index once per projection. Never rebuild the whole replica for each causal permission lookup. */
export function createV2HistoryView(replica: SharedReplica) {
  const pending = new Set(replica.pendingOperationIds);
  const index = createV2AuthorityIndex(replica.groupId);
  for (const op of replica.operations) if (!pending.has(op.operationId)) index.accept(op);
  return index.view;
}

/** The receiver adds only authenticated, authorized facts; invalid writes never establish later privileges. */
export function createV2AuthorityIndex(groupId: string) {
  const ready: SharedOperation[] = []; const byId = new Map<string, SharedOperation>();
  const topics = new Map<string, SharedOperation[]>(); const types = new Map<SharedEntityType, SharedOperation[]>();
  const occurrences = new Map<string, SharedOperation[]>();
  const accept = (op: SharedOperation) => {
    if (op.groupId !== groupId || byId.has(op.operationId)) throw new Error('Duplicate or foreign authority fact');
    ready.push(op); byId.set(op.operationId, op);
    const topic = `${op.entityType}:${op.entityId}`; const list = topics.get(topic) ?? []; list.push(op); topics.set(topic, list);
    const type = types.get(op.entityType) ?? []; type.push(op); types.set(op.entityType, type);
    const occurrenceId = op.entityType === 'completion' ? op.entityId : op.payload.occurrenceId;
    if (typeof occurrenceId === 'string') { const facts = occurrences.get(occurrenceId) ?? []; facts.push(op); occurrences.set(occurrenceId, facts); }
  };
  const observed = (operations: readonly SharedOperation[], at: SharedOperation) => operations.filter((op) => causallyPrecedes(op, at));
  const view = {
    groupId, ready,
    byId: (id: string) => byId.get(id),
    topic: (type: SharedEntityType, id: string) => topics.get(`${type}:${id}`) ?? [],
    ofType: (type: SharedEntityType) => types.get(type) ?? [],
    forOccurrence: (id: string) => occurrences.get(id) ?? [],
    observed,
    field(type: SharedEntityType, id: string, field: string, at: SharedOperation, filter: (op: SharedOperation) => boolean = () => true):
      { value: JsonValue; operations: SharedOperation[] } | null {
      const writing = observed(topics.get(`${type}:${id}`) ?? [], at).filter((op) => filter(op)
        && (field === '$alive' || Object.hasOwn(op.payload, field)));
      const latest = maximalCausalFacts(writing);
      if (!latest.length) return null;
      const value = (op: SharedOperation): JsonValue => field === '$alive' ? op.operationType !== 'delete' : op.payload[field];
      if (new Set(latest.map((op) => canonicalJson(value(op)))).size > 1) throw new V2HistoryConflictError(`Unresolved ${type}.${field}`);
      return { value: value(latest[0]), operations: latest };
    },
  };
  return { view, accept };
}
export type V2HistoryView = ReturnType<typeof createV2HistoryView>;
