import { sharedGoogleNamespace } from '../google-sync/workspace-policy.ts';

/** Notification metadata contains only an opaque scope; never infer a group from a chore name. */
export function notificationWorkspace(data: unknown, userId: string | null,
  groups: readonly { userId: string; groupId: string; status: string }[]): { userId: string; groupId: string } | null | undefined {
  if (!data || typeof data !== 'object' || !('kind' in data) || data.kind !== 'daily-housework-digest') return undefined;
  if (!('workspace' in data)) return null;
  if (!userId || typeof data.workspace !== 'string' || !/^[a-f0-9]{64}$/u.test(data.workspace)) return undefined;
  const group = groups.find((item) => item.userId === userId && item.status === 'active'
    && sharedGoogleNamespace(item.userId, item.groupId) === data.workspace);
  return group ? { userId: group.userId, groupId: group.groupId } : undefined;
}
