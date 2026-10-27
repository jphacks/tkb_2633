import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { VerifiedSharedRoster } from '../roster.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { maximalCausalFacts } from './causal-facts.ts';
import { commonFrame } from './common-frames.ts';
import { deriveClaims } from './claims.ts';
import type { ClaimFact, ClaimRelease, ClaimResolution } from './claims.ts';
import type { GroupPolicy, SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { V2HistoryConflictError } from './history-view.ts';

export function rosterAtOperation(archive: readonly VerifiedSharedRoster[], operation: SharedOperation): VerifiedSharedRoster {
  const epoch = archive[operation.keyVersion - 1];
  if (!epoch || epoch.body.keyVersion !== operation.keyVersion || epoch.body.groupId !== operation.groupId) throw new Error('Missing original membership epoch');
  return epoch;
}
export function groupPolicyAt(view: V2HistoryView, operation: SharedOperation): GroupPolicy {
  const configuration = view.field('groupPolicy', 'policy', 'configuration', operation);
  if (!configuration) throw new Error('Missing group policy at authoring');
  return configuration.value as unknown as GroupPolicy;
}

/** Only signed facts observed by the author can establish the authority of a new operation. */
export function frameAtOperation(view: V2HistoryView, archive: readonly VerifiedSharedRoster[], operation: SharedOperation,
  choreId: string, anchorDate: LocalDate, ruleVersion?: number) {
  if (view.field('chore', choreId, '$alive', operation)?.value !== true) throw new Error('Unknown or deleted shared chore');
  const configuration = view.field('chorePolicy', choreId, 'configuration', operation, (op) => ruleVersion === undefined
    || (op.payload.configuration as unknown as SharedChoreConfiguration).ruleVersion === ruleVersion);
  if (!configuration) throw new Error('Missing common chore configuration');
  const config = configuration.value as unknown as SharedChoreConfiguration;
  const frame = commonFrame(view.groupId, choreId, config, anchorDate);
  const epoch = rosterAtOperation(archive, operation); const activeMemberIds = epoch.body.members.map((member) => member.userId);
  const memberSets = configuration.operations.map((fact) => rosterAtOperation(archive, fact).body.members.map((member) => member.userId).sort());
  if (config.policy.assignment.mode === 'all' && new Set(memberSets.map((members) => canonicalJson(members))).size > 1) throw new V2HistoryConflictError('Confirm members for the common configuration');
  const configuredMembers = memberSets[0];
  const base = config.policy.assignment.mode === 'all' ? configuredMembers : config.policy.assignment.memberIds;
  const matching = view.observed(view.ofType('assignmentRule'), operation).filter((fact) => fact.payload.choreId === choreId
    && fact.payload.ruleVersion === config.ruleVersion && (fact.payload.scope === 'once' ? fact.payload.fromOccurrenceId === frame.id : (fact.payload.fromAnchorDate as string) <= anchorDate));
  const once = matching.filter((fact) => fact.payload.scope === 'once');
  const assignments = maximalCausalFacts(once.length ? once : matching);
  if (new Set(assignments.map((fact) => canonicalJson({ memberIds: fact.payload.memberIds, fixed: fact.payload.fixed }))).size > 1) throw new V2HistoryConflictError('Concurrent assignee rules');
  const configuredAssignees = assignments.length ? assignments[0].payload.memberIds as string[] : base;
  const assigneeIds = configuredAssignees.filter((uid) => activeMemberIds.includes(uid)).sort();
  const facts = view.observed(view.forOccurrence(frame.id), operation);
  const claims = deriveClaims(frame.id, { activeMemberIds,
    claims: facts.filter((op) => op.entityType === 'claim').map((op) => ({ ...op, ...op.payload }) as unknown as ClaimFact),
    releases: facts.filter((op) => op.entityType === 'claimRelease').map((op) => ({ ...op, ...op.payload }) as unknown as ClaimRelease),
    resolutions: facts.filter((op) => op.entityType === 'claimResolution').map((op) => ({ ...op, ...op.payload }) as unknown as ClaimResolution) });
  const useClaims = config.policy.completion === 'one' && !assigneeIds.length;
  return { frame, config, configuredAssignees: [...configuredAssignees], activeMemberIds, claims,
    assigneeIds: useClaims ? claims.assigneeIds : assigneeIds,
    assignmentFixed: assignments.some((fact) => fact.payload.fixed === true)
      || useClaims && maximalCausalFacts(facts.filter((op) => op.entityType === 'claimResolution')).some((fact) => fact.payload.fixed === true),
    subjectUserIds: config.policy.completion === 'perMember' ? [...configuredAssignees].sort() : [] };
}
