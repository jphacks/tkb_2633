import { addDays } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { JsonValue } from '../operations.ts';
import { compareOperationIds } from '../operations.ts';

export interface V2Dependency { id: string; predecessorChoreId: string; successorChoreId: string; required: boolean; minimumGapDays: number }
export function v2Dependency(id: string, values: Record<string, JsonValue>): V2Dependency | null {
  const policy = values.policyData ?? {};
  if (typeof values.predecessorChoreId !== 'string' || typeof values.successorChoreId !== 'string'
    || !policy || typeof policy !== 'object' || Array.isArray(policy)
    || Object.keys(policy).some((key) => !['required', 'minimumGapDays'].includes(key))
    || 'required' in policy && typeof policy.required !== 'boolean'
    || 'minimumGapDays' in policy && (!Number.isSafeInteger(policy.minimumGapDays) || Number(policy.minimumGapDays) < 0 || Number(policy.minimumGapDays) > 14)) return null;
  return { id, predecessorChoreId: values.predecessorChoreId, successorChoreId: values.successorChoreId,
    required: policy.required !== false, minimumGapDays: Number(policy.minimumGapDays ?? 0) };
}
/** Cycles require explicit review. A broken edge must not remove unrelated chores from the plan. */
export function cyclicV2Dependencies(dependencies: readonly V2Dependency[]): Set<string> {
  const outgoing = new Map<string, V2Dependency[]>(); const nodes = new Set<string>();
  for (const edge of dependencies.filter((entry) => entry.required)) {
    const list = outgoing.get(edge.predecessorChoreId) ?? []; list.push(edge); outgoing.set(edge.predecessorChoreId, list);
    nodes.add(edge.predecessorChoreId); nodes.add(edge.successorChoreId);
  }
  const incoming = new Map<string, string[]>();
  for (const edges of outgoing.values()) for (const edge of edges) {
    const list = incoming.get(edge.successorChoreId) ?? []; list.push(edge.predecessorChoreId); incoming.set(edge.successorChoreId, list);
  }
  const visited = new Set<string>(); const order: string[] = [];
  for (const root of [...nodes].sort(compareOperationIds)) {
    if (visited.has(root)) continue;
    visited.add(root); const stack = [{ node: root, cursor: 0 }];
    while (stack.length) {
      const top = stack.at(-1)!; const edges = outgoing.get(top.node) ?? [];
      if (top.cursor >= edges.length) { order.push(top.node); stack.pop(); continue; }
      const target = edges[top.cursor++].successorChoreId;
      if (!visited.has(target)) { visited.add(target); stack.push({ node: target, cursor: 0 }); }
    }
  }
  const component = new Map<string, number>(); const componentSize = new Map<number, number>(); let nextComponent = 0;
  for (const root of order.reverse()) {
    if (component.has(root)) continue;
    const id = ++nextComponent; const stack = [root]; component.set(root, id); let size = 0;
    while (stack.length) {
      const node = stack.pop()!; size++;
      for (const previous of incoming.get(node) ?? []) if (!component.has(previous)) { component.set(previous, id); stack.push(previous); }
    }
    componentSize.set(id, size);
  }
  return new Set(dependencies.filter((edge) => edge.required && component.get(edge.predecessorChoreId) === component.get(edge.successorChoreId)
    && (edge.predecessorChoreId === edge.successorChoreId || componentSize.get(component.get(edge.predecessorChoreId)!)! > 1)).map((edge) => edge.id));
}
export function dependencyLowerBound(predecessorEnd: LocalDate, edge: V2Dependency): LocalDate { return addDays(predecessorEnd, edge.minimumGapDays); }
