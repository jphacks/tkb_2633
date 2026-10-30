import { createPrivateCalendarRootAuditContext } from './private-calendar-root-audit';
import { developmentPrivateCalendarAuthorityIntents, developmentPrivateCalendarCache, developmentPrivateCalendarKeyOutbox, developmentPrivateCalendarPairing } from './private-calendar-secrets';
import { createPrivateCalendarAuthoritySync } from '../../features/sharing/private-calendar/authority-sync';
import { createPrivateCalendarKeyDelivery } from '../../features/sharing/private-calendar/key-delivery';
import { createPrivateCalendarPairingController } from '../../features/sharing/private-calendar/pairing-controller';

export async function createPrivateCalendarPairAuditContext(platform: string, host: unknown, port: unknown) {
  if (!__DEV__) throw new Error('端末間の検査は開発ビルドだけで使用できます。');
  const base = await createPrivateCalendarRootAuditContext(platform, host, port, 'pairing');
  try {
    const { userId, secrets, cloud } = base; const intents = developmentPrivateCalendarAuthorityIntents(userId);
    const outbox = developmentPrivateCalendarKeyOutbox(userId); const candidates = developmentPrivateCalendarPairing(userId);
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets, intents, cloud });
    const delivery = createPrivateCalendarKeyDelivery({ userId, secrets, outbox, cloud });
    const pair = createPrivateCalendarPairingController({ userId, secrets, candidates, intents, authoritySync, delivery, cloud });
    return { ...base, authoritySync, delivery, pair, outbox, cache: developmentPrivateCalendarCache(userId) };
  } catch (error) { await base.close(); throw error; }
}
