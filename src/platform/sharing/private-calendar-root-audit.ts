import { deleteApp, initializeApp } from 'firebase/app';
import { connectFirestoreEmulator, doc, getDocFromServer, initializeFirestore, terminate } from 'firebase/firestore';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { PrivateCalendarRootAuditPort } from '../../features/sharing/development/private-calendar-root-audit.ts';
import { developmentPrivateCalendarRootSetup, developmentPrivateCalendarSecrets } from './private-calendar-secrets';
import { nativePrivateCalendarCrypto } from './native-private-calendar-crypto';
import { createPrivateCalendarCloud } from './private-calendar-cloud.ts';

export function privateCalendarAuditEndpoint(host: unknown, port: unknown) {
  if (typeof host !== 'string' || !/^\d{1,3}(\.\d{1,3}){3}$/.test(host) || !['8185', '8186'].includes(String(port))) throw new Error('検査専用Emulatorの接続先が必要です。');
  const octets = host.split('.').map(Number);
  if (octets.some((value, index) => value > 255 || String(value) !== host.split('.')[index]) || !(octets[0] === 127 || octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)) throw new Error('接続先はローカルの検査用Emulatorに限定されます。');
  return Object.freeze({ host, port: Number(port) });
}

/** No Firebase Auth, production app, user account or normal SQLite is accessed. */
export async function createPrivateCalendarRootAuditContext(platform: string, host: unknown, port: unknown): Promise<PrivateCalendarRootAuditPort & { close(): Promise<void> }> {
  if (!__DEV__) throw new Error('検査用の初回設定は開発ビルドだけで使用できます。');
  if (platform !== 'ios' && platform !== 'android') throw new Error('実機の検査用設定が必要です。');
  const endpoint = privateCalendarAuditEndpoint(host, port);
  const userId = `development-calendar-native-root-${platform}-interruption-v1`;
  const tag = bytesToHex(await nativePrivateCalendarCrypto.randomBytes(12));
  const apps: ReturnType<typeof initializeApp>[] = []; const databases: ReturnType<typeof initializeFirestore>[] = [];
  const close = async () => {
    try { await Promise.all(databases.map(db => terminate(db))); }
    finally { await Promise.all(apps.map(app => deleteApp(app))); }
  };
  function client(uid: string, suffix: string) {
    const app = initializeApp({ projectId: 'demo-liflow-private-native', apiKey: 'development-only-emulator', appId: `development-root-${tag}` }, `private-root-audit-${tag}-${suffix}`); apps.push(app);
    const db = initializeFirestore(app, { experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false }); databases.push(db);
    connectFirestoreEmulator(db, endpoint.host, endpoint.port, { mockUserToken: { sub: uid } }); return db;
  }
  try {
    const db = client(userId, 'owner'); const outsider = client(`${userId}-other`, 'other');
    return { userId, crypto: nativePrivateCalendarCrypto, secrets: developmentPrivateCalendarSecrets(), intents: developmentPrivateCalendarRootSetup(userId),
      cloud: createPrivateCalendarCloud(db, userId, () => userId, nativePrivateCalendarCrypto), close,
      async assertOtherUserDenied() {
        try { await getDocFromServer(doc(outsider, 'privateCalendars', userId)); }
        catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') return; throw error; }
        throw new Error('検査用Rulesが別UIDの読取を拒否していません。');
      } };
  } catch (error) { await close(); throw error; }
}
