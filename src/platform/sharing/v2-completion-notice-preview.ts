import { getPermissionsAsync, getPresentedNotificationsAsync, dismissNotificationAsync } from 'expo-notifications';
import { createV2CompletionNoticePresenter } from './v2-completion-notices';
import { v2CompletionNoticePrefix } from '../../features/sharing/v2/completion-notices';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema';
import { sharedDocumentDigest } from '../../features/sharing/crypto';

/** OS-delivery check only. It neither invents a server receipt nor acts as evidence of a real shared completion. */
export function createV2CompletionNoticePreview() {
  if (!__DEV__) throw new Error('完了通知の配信検査は開発ビルド専用です。');
  const scope = { userId: 'qa-notice-owner-20261029', groupId: `qa-notice-group-20261029.${V2_SCHEDULER_VERSION}` };
  const prefix = v2CompletionNoticePrefix(scope.userId, scope.groupId); const key = prefix + sharedDocumentDigest('synthetic-os-delivery-v1');
  const guard = async () => { if (!__DEV__) throw new Error('検査用の通知配信を利用できません。'); };
  const other = async () => sharedDocumentDigest(JSON.stringify((await getPresentedNotificationsAsync()).filter(row => !row.request.identifier.startsWith(prefix))
    .map(row => row.request).sort((a, b) => a.identifier.localeCompare(b.identifier))));
  return {
    async present() {
      await guard(); if (!(await getPermissionsAsync()).granted) throw new Error('通知が許可されていません。'); await guard();
      const before = await other();
      await createV2CompletionNoticePresenter(scope)({ key, title: 'LiFlow・完了通知の配信検査', body: '検査用の合成家事が完了しました。', count: 1 }, guard);
      if (await other() !== before) throw new Error('他の表示通知を再確認してください。');
      return '完了通知のOS要求 PASS：合成1件・他領域保持';
    },
    async inspect() {
      await guard(); const found = (await getPresentedNotificationsAsync()).filter(row => row.request.identifier === key);
      if (found.length !== 1 || found[0].request.content.title !== 'LiFlow・完了通知の配信検査'
        || found[0].request.content.body !== '検査用の合成家事が完了しました。' || found[0].request.content.data?.kind !== 'v2-housework-completed') throw new Error('OSの通知表示を確認できません。');
      return '完了通知のOS表示 PASS：合成1件・内容一致';
    },
    async clear() {
      await guard(); const before = await other();
      for (const row of await getPresentedNotificationsAsync()) if (row.request.identifier.startsWith(prefix)) { await guard(); await dismissNotificationAsync(row.request.identifier); }
      if ((await getPresentedNotificationsAsync()).some(row => row.request.identifier.startsWith(prefix)) || await other() !== before) throw new Error('通知の片付けを確認できません。');
      return '完了通知の片付け PASS：合成0件・他領域保持';
    },
  };
}
