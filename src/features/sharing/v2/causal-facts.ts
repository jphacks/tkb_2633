import { canonicalJson, causallyPrecedes } from '../operations.ts';
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
  return facts.filter((fact) => !facts.some((other) => fact !== other && causallyPrecedes(fact, other)));
}
