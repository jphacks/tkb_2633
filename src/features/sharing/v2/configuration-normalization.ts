import type { SharedChoreConfiguration } from './model.ts';

/** Member selection is a set; original signed facts remain unchanged. */
export function normalizeV2Configuration(value: SharedChoreConfiguration): SharedChoreConfiguration {
  return { ...value, policy: { ...value.policy, assignment: { ...value.policy.assignment, memberIds: [...value.policy.assignment.memberIds].sort() } },
    ...(value.targetMemberIds ? { targetMemberIds: [...value.targetMemberIds].sort() } : {}) };
}
