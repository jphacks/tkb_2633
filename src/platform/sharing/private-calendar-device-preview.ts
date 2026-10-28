import { createPrivateCalendarPairAuditContext } from './private-calendar-pair-audit';
import { developmentPrivateCalendarAuthorityIntents, developmentPrivateCalendarPairing } from './private-calendar-secrets';
import { createPrivateCalendarDeviceSession } from '../../features/sharing/private-calendar/device-session';

/** Reuses only the fixed synthetic two-device profile; never adopts a real login or resets prior QA. */
export async function createPrivateCalendarDevicePreview(platform: string, host: unknown, port: unknown) {
  if (!__DEV__) throw new Error('端末設定の検査は開発ビルドだけで使用できます。');
  const context = await createPrivateCalendarPairAuditContext(platform, host, port);
  try {
    if (context.userId !== 'development-calendar-native-pairing-e2e-v1') throw new Error('専用の本人端末検査を使用してください。');
    const { userId, secrets, cloud } = context;
    const session = createPrivateCalendarDeviceSession({ userId, secrets, cloud, roots: context.intents,
      intents: developmentPrivateCalendarAuthorityIntents(userId), candidates: developmentPrivateCalendarPairing(userId), outbox: context.outbox, cache: context.cache,
      assertOwner() { if (!__DEV__ || userId !== 'development-calendar-native-pairing-e2e-v1') throw new Error('本人端末の検査設定が変わりました。'); } });
    return { session, close: context.close };
  } catch (error) { await context.close(); throw error; }
}
