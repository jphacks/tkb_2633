import { AndroidImportance, dismissNotificationAsync, getPermissionsAsync, getPresentedNotificationsAsync, scheduleNotificationAsync, setNotificationChannelAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createV2CompletionNoticeStore } from '../storage/sharing-v2-completion-notices';
import { createV2CompletionNoticeRuntime } from '../../features/sharing/v2/completion-notice-runtime';
import { v2CompletionNoticePrefix } from '../../features/sharing/v2/completion-notices';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity';
import type { V2CompletionNotice } from '../../features/sharing/v2/completion-notice-runtime';

export function createV2CompletionNoticePresenter(scope: { userId: string; groupId: string }) {
  const namespace = v2NativeWorkspaceNamespace(scope.userId, scope.groupId); const prefix = v2CompletionNoticePrefix(scope.userId, scope.groupId);
  return async (notice: V2CompletionNotice, assertCurrent: () => Promise<void>) => {
    if (!notice.key.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(notice.key.slice(prefix.length)) || !Number.isSafeInteger(notice.count) || notice.count < 1) throw new Error('完了通知の対象を確認してください。');
    await assertCurrent();
    if (Platform.OS === 'android') await setNotificationChannelAsync('housework-completions', { name: '共有家事の完了', importance: AndroidImportance.DEFAULT });
    await assertCurrent();
    await scheduleNotificationAsync({ identifier: notice.key, content: { title: notice.title, body: notice.body,
      data: { kind: 'v2-housework-completed', workspace: namespace, count: notice.count }, color: '#4AADE0' },
      trigger: Platform.OS === 'android' ? { channelId: 'housework-completions' } : null });
  };
}

/** A local notification after synchronization receives a completion, not a server push or a background guarantee. */
export function createNativeV2CompletionNotices(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const store = createV2CompletionNoticeStore(input);
  return createV2CompletionNoticeRuntime({ ...input, store,
    hasPermission: async () => { await input.assertAccess(); const value = await getPermissionsAsync(); await input.assertAccess(); return value.granted; },
    present: createV2CompletionNoticePresenter(input) });
}
export async function clearInactiveV2CompletionNotices(allowed: readonly { userId: string; groupId: string }[], assertCurrent: () => void | Promise<void> = () => {}) {
  await assertCurrent(); const keep = new Set(allowed.map(scope => v2CompletionNoticePrefix(scope.userId, scope.groupId)));
  const presented = await getPresentedNotificationsAsync(); await assertCurrent();
  for (const notification of presented) {
    const id = notification.request.identifier; const prefix = /^liflow-v2-completed:[a-f0-9]{64}:/u.exec(id)?.[0];
    if (prefix && !keep.has(prefix)) { await assertCurrent(); await dismissNotificationAsync(id); }
  }
}
export async function clearV2CompletionNoticesForScope(userId: string, groupId: string) {
  const prefix = v2CompletionNoticePrefix(userId, groupId);
  for (const value of await getPresentedNotificationsAsync()) if (value.request.identifier.startsWith(prefix)) await dismissNotificationAsync(value.request.identifier);
}
