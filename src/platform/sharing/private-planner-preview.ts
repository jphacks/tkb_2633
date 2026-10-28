import { initializeApp, deleteApp } from 'firebase/app';
import { connectFirestoreEmulator, initializeFirestore, terminate, disableNetwork, enableNetwork } from 'firebase/firestore';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createPrivateCalendarPairAuditContext } from './private-calendar-pair-audit';
import { privateCalendarAuditEndpoint } from './private-calendar-root-audit';
import { developmentPrivatePlannerPreferences, developmentPrivateCalendarAuthorityIntents, developmentPrivateCalendarPairing } from './private-calendar-secrets';
import { createPrivatePlannerCloud } from './private-planner-cloud';
import { createPrivatePreferenceSync } from '../../features/sharing/private-planner/preference-sync';
import { createPrivateCalendarDeviceSession } from '../../features/sharing/private-calendar/device-session';

/** Existing approved synthetic devices only. No new identity, approval, real account, group or Google provider is created here. */
export async function createPrivatePlannerPreview(platform: string, host: unknown, port: unknown) {
  if (!__DEV__) throw new Error('本人設定の端末間検査は開発ビルド専用です。');
  const endpoint = privateCalendarAuditEndpoint(host, port); const context = await createPrivateCalendarPairAuditContext(platform, host, port);
  let app: ReturnType<typeof initializeApp> | null = null; let db: ReturnType<typeof initializeFirestore> | null = null;
  const close = async () => { try { if (db) await terminate(db); } finally { try { if (app) await deleteApp(app); } finally { await context.close(); } } };
  try {
    const { userId, secrets, crypto } = context;
    if (userId !== 'development-calendar-native-pairing-e2e-v1') throw new Error('検査専用の本人設定を確認してください。');
    const assertOwner = () => { if (!__DEV__ || userId !== 'development-calendar-native-pairing-e2e-v1') throw new Error('本人設定の検査用保存先が変わりました。'); };
    const devices = createPrivateCalendarDeviceSession({ userId, assertOwner, secrets, roots: context.intents,
      intents: developmentPrivateCalendarAuthorityIntents(userId), candidates: developmentPrivateCalendarPairing(userId), outbox: context.outbox, cache: context.cache, cloud: context.cloud });
    const view = await devices.synchronizeDevices({ force: true }); if (view.phase !== 'approved' || !view.keyReady) throw new Error('合成本人端末の承認と鍵配布を先に確認してください。');
    const tag = bytesToHex(await crypto.randomBytes(12));
    app = initializeApp({ projectId: 'demo-liflow-private-native', apiKey: 'development-only-emulator', appId: `development-private-preferences-${tag}` }, `private-preferences-${tag}`);
    db = initializeFirestore(app, { experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false });
    connectFirestoreEmulator(db, endpoint.host, endpoint.port, { mockUserToken: { sub: userId } });
    const cloud = createPrivatePlannerCloud(db, userId, () => { assertOwner(); return userId; }); const store = developmentPrivatePlannerPreferences(userId);
    const engine = createPrivatePreferenceSync({ ownerUserId: userId, assertOwner, secrets, crypto, cloud, store });
    const connection = db;
    return { store, engine, async pauseTransport() { assertOwner(); await disableNetwork(connection); assertOwner(); },
      async synchronize() { assertOwner(); await enableNetwork(connection); assertOwner(); return engine.synchronize(true); }, close };
  } catch (error) { await close(); throw error; }
}
