import { canonicalJson } from '../operations.ts';
import type { CausalStamp } from './model.ts';

export function uniqueCausalFacts<T extends CausalStamp>(input: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const fact of input) {
    const previous = unique.get(fact.operationId);
    if (previous && canonicalJson(previous) !== canonicalJson(fact)) throw new Error('同じ操作IDの内容が一致しません。');
    unique.set(fact.operationId, fact);
  }
  return [...unique.values()].sort((a, b) => a.operationId < b.operationId ? -1 : a.operationId > b.operationId ? 1 : 0);
}
export function maximalCausalFacts<T extends CausalStamp>(input: readonly T[]): T[] {
  const facts = uniqueCausalFacts(input);
  const observed = new Map<string, { first: number; second: number; operationId: string }>();
  for (const fact of facts) for (const [device, count] of Object.entries(fact.context)) {
    const previous = observed.get(device);
    if (!previous || count > previous.first) observed.set(device, { first: count, second: previous?.first ?? 0, operationId: fact.operationId });
    else previous.second = Math.max(previous.second, count);
  }
  return facts.filter((fact) => {
    const frontier = observed.get(fact.authorDeviceId);
    return !frontier || (frontier.operationId === fact.operationId ? frontier.second : frontier.first) < fact.deviceSequence;
  });
}
