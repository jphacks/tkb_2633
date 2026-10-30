import { causallyPrecedes } from '../operations.ts';
import { maximalCausalFacts, uniqueCausalFacts } from './causal-facts.ts';
import type { CausalStamp } from './model.ts';

export interface ClaimFact extends CausalStamp { occurrenceId: string; userId: string }
export interface ClaimRelease extends CausalStamp { occurrenceId: string; userId: string; targetOperationIds: string[] }
export interface ClaimResolution extends CausalStamp { occurrenceId: string; claimOperationIds: string[]; assigneeIds: string[]; fixed: boolean }
export interface ClaimState {
  kind: 'unassigned' | 'claimed' | 'provisional' | 'resolved';
  assigneeIds: string[]; activeClaimOperationIds: string[];
}

/** Independent claims remain executable; only an explicit observed decision chooses a final assignee. */
export function deriveClaims(occurrenceId: string, input: { claims: readonly ClaimFact[]; releases: readonly ClaimRelease[];
  resolutions: readonly ClaimResolution[]; activeMemberIds: readonly string[]; ignoredClaimOperationIds?: ReadonlySet<string> }): ClaimState {
  const claims = uniqueCausalFacts(input.claims).filter((fact) => fact.occurrenceId === occurrenceId);
  const byId = new Map(claims.map((fact) => [fact.operationId, fact])); const released = new Set<string>();
  const resolutions = maximalCausalFacts(input.resolutions.filter((fact) => fact.occurrenceId === occurrenceId));
  const releases = uniqueCausalFacts(input.releases).filter((fact) => fact.occurrenceId === occurrenceId);
  for (const release of releases) {
    for (const targetId of release.targetOperationIds) {
      const target = byId.get(targetId);
      if (!target || target.userId !== release.userId || !causallyPrecedes(target, release)) throw new Error('引き受け解除の対象と権限を確認してください。');
      released.add(targetId);
    }
    if (resolutions.some((resolution) => resolution.fixed && resolution.assigneeIds.includes(release.userId)
      && resolution.claimOperationIds.some((id) => release.targetOperationIds.includes(id)) && causallyPrecedes(resolution, release))) {
      throw new Error('管理者が固定した担当は、変更を申請してください。');
    }
  }
  const activeClaims = claims.filter((fact) => !released.has(fact.operationId) && !input.ignoredClaimOperationIds?.has(fact.operationId) && input.activeMemberIds.includes(fact.userId));
  for (const resolution of resolutions) {
    if (new Set(resolution.assigneeIds).size !== resolution.assigneeIds.length || !resolution.assigneeIds.length) throw new Error('正式な担当者を選んでください。');
    const observed = resolution.claimOperationIds.map((id) => {
      const claim = byId.get(id);
      if (!claim || !causallyPrecedes(claim, resolution)) throw new Error('未確認の引き受けを解決できません。');
      return claim;
    });
    if (resolution.assigneeIds.some((id) => !observed.some((claim) => claim.userId === id))) throw new Error('引き受けた人から正式担当を選んでください。');
    if (resolution.assigneeIds.some((id) => observed.filter((claim) => claim.userId === id).every((claim) => releases.some((release) => release.targetOperationIds.includes(claim.operationId)
      && causallyPrecedes(release, resolution))))) throw new Error('解除済みの引き受けを担当へ戻すことはできません。');
  }
  const covered = new Set(resolutions.flatMap((fact) => fact.claimOperationIds));
  const unresolved = activeClaims.filter((fact) => !covered.has(fact.operationId));
  const selected = resolutions.flatMap((fact) => fact.assigneeIds.filter((id) => fact.fixed
    || activeClaims.some((claim) => claim.userId === id && fact.claimOperationIds.includes(claim.operationId))));
  const fixedReleaseConflict = resolutions.some((fact) => fact.fixed && releases.some((release) => fact.assigneeIds.includes(release.userId)
    && release.targetOperationIds.some((id) => fact.claimOperationIds.includes(id)) && !causallyPrecedes(release, fact) && !causallyPrecedes(fact, release)));
  const assigneeIds = [...new Set([...selected, ...unresolved.map((fact) => fact.userId)])]
    .filter((id) => input.activeMemberIds.includes(id)).sort();
  const choices = new Set(resolutions.map((fact) => JSON.stringify({ ids: [...fact.assigneeIds].sort(), fixed: fact.fixed })));
  return { kind: !assigneeIds.length ? 'unassigned' : choices.size > 1 || fixedReleaseConflict || unresolved.length && selected.length || assigneeIds.length > 1 ? 'provisional'
    : selected.length ? 'resolved' : 'claimed', assigneeIds, activeClaimOperationIds: activeClaims.map((fact) => fact.operationId).sort() };
}
