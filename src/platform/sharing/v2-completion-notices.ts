import { getPermissionsAsync } from 'expo-notifications';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { createV2CompletionNoticeStore } from '../storage/sharing-v2-completion-notices';
import { createV2CompletionNoticeRuntime } from '../../features/sharing/v2/completion-notice-runtime';
import { v2CompletionNoticePrefix } from '../../features/sharing/v2/completion-notices';
import { v2NativeWorkspaceNamespace } from '../../features/sharing/v2/native-identity';
import { createV2ImmediateNoticePresenter, clearV2ImmediateNotices } from './v2-immediate-notices';

export function developmentV2CompletionNoticePrefix(scope: { userId: string; groupId: string }) {
  if (!__DEV__) throw new Error('完了通知の検査用保存先は開発ビルド専用です。');
  return `liflow-qa-v2-completed:${v2NativeWorkspaceNamespace(scope.userId, scope.groupId)}:`;
}
export function createV2CompletionNoticePresenter(scope: { userId: string; groupId: string }, purpose: 'workspace' | 'development-os-audit' = 'workspace') {
  const prefix = purpose === 'development-os-audit' ? developmentV2CompletionNoticePrefix(scope) : v2CompletionNoticePrefix(scope.userId, scope.groupId);
  return createV2ImmediateNoticePresenter(scope, { prefix, kind: 'v2-housework-completed', channelId: 'housework-completions', channelName: '共有家事の完了' });
}

/** A local notification after synchronization receives a completion, not a server push or a background guarantee. */
export function createNativeV2CompletionNotices(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const store = createV2CompletionNoticeStore(input);
  return createV2CompletionNoticeRuntime({ ...input, store,
    hasPermission: async () => { await input.assertAccess(); const value = await getPermissionsAsync(); await input.assertAccess(); return value.granted; },
    present: createV2CompletionNoticePresenter(input) });
}
export function clearInactiveV2CompletionNotices(allowed: readonly { userId: string; groupId: string }[], assertCurrent: () => void | Promise<void> = () => {}) {
  const keep = new Set(allowed.map(scope => v2CompletionNoticePrefix(scope.userId, scope.groupId)));
  return clearV2ImmediateNotices(id => { const prefix = /^liflow-v2-completed:[a-f0-9]{64}:/u.exec(id)?.[0]; return Boolean(prefix && !keep.has(prefix)); }, assertCurrent);
}
export function clearV2CompletionNoticesForScope(userId: string, groupId: string) {
  const prefix = v2CompletionNoticePrefix(userId, groupId);
  return clearV2ImmediateNotices(id => id.startsWith(prefix), () => {});
}
