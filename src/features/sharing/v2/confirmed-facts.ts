import type { CausalStamp } from './model.ts';
import type { ConfirmationProof } from './confirmation.ts';
import { observedConfirmation } from './confirmation.ts';
import { maximalCausalFacts, uniqueCausalFacts } from './causal-facts.ts';

/** Replacing a pending request does not replace its unseen future approval. Equivalent proofs stay alternatives. */
export function maximalConfirmedFacts<Fact extends CausalStamp & { confirmation?: ConfirmationProof }>(input: readonly Fact[], basis: (fact: Fact) => readonly string[]): Fact[] {
  const facts = uniqueCausalFacts(input); const direct = new Set(maximalCausalFacts(facts).map((fact) => fact.operationId));
  const confirmed = new Map(facts.filter((fact) => fact.confirmation).map((fact) => [fact.operationId, fact])); const replaced = new Set<string>();
  for (const fact of facts) for (const id of basis(fact)) {
    const old = confirmed.get(id);
    if (old?.confirmation && old.operationId !== fact.operationId && observedConfirmation(old.confirmation, fact)) replaced.add(id);
  }
  return facts.filter((fact) => fact.confirmation ? !replaced.has(fact.operationId) : direct.has(fact.operationId));
}
