import { AndroidImportance, cancelScheduledNotificationAsync, dismissNotificationAsync, getPermissionsAsync, getPresentedNotificationsAsync, scheduleNotificationAsync, setNotificationChannelAsync } from 'expo-notifications';
import { Platform } from 'react-native';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createV2CompletionNoticeStore } from '../storage/sharing-v2-completion-notices';
import { createV2CompletionNoticeRuntime } from '../../features/sharing/v2/completion-notice-runtime';
import { v2CompletionNoticePrefix } from '../../features/sharing/v2/completion-notices';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity';
import type { V2CompletionNotice } from '../../features/sharing/v2/completion-notice-runtime';
import { withLocalNotificationOperation } from '../../features/notifications/reconcile-local-notifications';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';

export function developmentV2CompletionNoticePrefix(scope: { userId: string; groupId: string }) {
  if (!__DEV__) throw new Error('完了通知の検査用保存先は開発ビルド専用です。');
  return `liflow-qa-v2-completed:${v2NativeWorkspaceNamespace(scope.userId, scope.groupId)}:`;
}
export function createV2CompletionNoticePresenter(scope: { userId: string; groupId: string }, purpose: 'workspace' | 'development-os-audit' = 'workspace') {
  const namespace = v2NativeWorkspaceNamespace(scope.userId, scope.groupId);
  const prefix = purpose === 'development-os-audit' ? developmentV2CompletionNoticePrefix(scope) : v2CompletionNoticePrefix(scope.userId, scope.groupId);
  return async (notice: V2CompletionNotice, assertCurrent: () => Promise<void>) => {
    const captured = { ...notice };
    if (!captured.key.startsWith(prefix) || !/^[a-f0-9]{64}$/u.test(captured.key.slice(prefix.length)) || !Number.isSafeInteger(captured.count) || captured.count < 1) throw new Error('完了通知の対象を確認してください。');
    return withLocalNotificationOperation(expoLocalNotificationGateway, async () => {
      await assertCurrent();
      const capacity = expoLocalNotificationGateway.maximumScheduledRequests;
      if (capacity !== undefined && (await expoLocalNotificationGateway.getScheduledRequests()).length >= capacity) throw new Error('端末の通知予約上限のため、完了通知を省略しました。');
      await assertCurrent();
      if (Platform.OS === 'android') await setNotificationChannelAsync('housework-completions', { name: '共有家事の完了', importance: AndroidImportance.DEFAULT });
      await assertCurrent();
      await scheduleNotificationAsync({ identifier: captured.key, content: { title: captured.title, body: captured.body,
        data: { kind: 'v2-housework-completed', workspace: namespace, count: captured.count }, color: '#4AADE0' },
        trigger: Platform.OS === 'android' ? { channelId: 'housework-completions' } : null });
    });
  };
}

/** A local notification after synchronization receives a completion, not a server push or a background guarantee. */
export function createNativeV2CompletionNotices(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const store = createV2CompletionNoticeStore(input);
  return createV2CompletionNoticeRuntime({ ...input, store,
    hasPermission: async () => { await input.assertAccess(); const value = await getPermissionsAsync(); await input.assertAccess(); return value.granted; },
    present: createV2CompletionNoticePresenter(input) });
}
function clearNotices(matches: (id: string) => boolean, assertCurrent: () => void | Promise<void>) {
  return withLocalNotificationOperation(expoLocalNotificationGateway, async () => {
    await assertCurrent(); const pending = await expoLocalNotificationGateway.getScheduledRequests(); await assertCurrent();
    for (const notification of pending) if (matches(notification.key)) { await assertCurrent(); await cancelScheduledNotificationAsync(notification.key); }
    const presented = await getPresentedNotificationsAsync(); await assertCurrent();
    for (const notification of [...presented]) if (matches(notification.request.identifier)) { await assertCurrent(); await dismissNotificationAsync(notification.request.identifier); }
  });
}
export function clearInactiveV2CompletionNotices(allowed: readonly { userId: string; groupId: string }[], assertCurrent: () => void | Promise<void> = () => {}) {
  const keep = new Set(allowed.map(scope => v2CompletionNoticePrefix(scope.userId, scope.groupId)));
  return clearNotices(id => { const prefix = /^liflow-v2-completed:[a-f0-9]{64}:/u.exec(id)?.[0]; return Boolean(prefix && !keep.has(prefix)); }, assertCurrent);
}
export function clearV2CompletionNoticesForScope(userId: string, groupId: string) {
  const prefix = v2CompletionNoticePrefix(userId, groupId);
  return clearNotices(id => id.startsWith(prefix), () => {});
}
