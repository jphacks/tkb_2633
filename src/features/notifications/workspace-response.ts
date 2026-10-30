import { sharedGoogleNamespace } from '../google-sync/workspace-policy.ts';
import { v2NativeWorkspaceNamespace } from '../sharing/v2/native-identity.ts';

export function isPlannerNotification(data: unknown): data is { kind: string; workspace?: unknown } {
  return Boolean(data && typeof data === 'object' && 'kind' in data && ['daily-housework-digest', 'v2-housework-digest', 'v2-housework-completed', 'v2-housework-load'].includes(String(data.kind)));
}

/** Notification metadata contains only an opaque scope; never infer a group from a chore name. */
export function notificationWorkspace(data: unknown, userId: string | null,
  groups: readonly { userId: string; groupId: string; status: string }[]): { userId: string; groupId: string } | null | undefined {
  if (!isPlannerNotification(data)) return undefined;
  if (!('workspace' in data)) return data.kind === 'daily-housework-digest' ? null : undefined;
  if (!userId || typeof data.workspace !== 'string' || !/^[a-f0-9]{64}$/u.test(data.workspace)) return undefined;
  const group = groups.find((item) => item.userId === userId && item.status === 'active'
    && (data.kind === 'daily-housework-digest' ? sharedGoogleNamespace(item.userId, item.groupId) : v2NativeWorkspaceNamespace(item.userId, item.groupId)) === data.workspace);
  return group ? { userId: group.userId, groupId: group.groupId } : undefined;
}
