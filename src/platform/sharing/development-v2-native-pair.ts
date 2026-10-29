import { initializeApp, deleteApp } from 'firebase/app';
import { connectFirestoreEmulator, initializeFirestore, disableNetwork, enableNetwork, terminate, doc, getDocFromServer } from 'firebase/firestore';
import { openDatabaseAsync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { createV2NativePair, v2PairScope, V2_PAIR_PROJECT } from '../../features/sharing/development/v2-native-pair';
import type { V2NativePair, V2PairRole } from '../../features/sharing/development/v2-native-pair';
import { privateCalendarAuditEndpoint } from './private-calendar-root-audit';
import { openSharingV2Database, sharingDatabaseDirectory } from './database-location';
import { loadOrCreateSharingDeviceIdentity, loadSharingGroupKey, saveSharingGroupKey } from './secure-store';
import { nativeSharingCrypto } from './native-crypto';
import { createSharingCloud } from './firestore-cloud';
import { drainPlannerDatabaseOperations, withPlannerDatabaseOperation } from '../storage/repository';

export type DevelopmentV2NativePair = V2NativePair & { network(enabled: boolean): Promise<void>; assertOutsiderDenied(): Promise<void>; dispose(): Promise<void> };
const contexts = new Map<string, Promise<DevelopmentV2NativePair>>();

/** Named demo Firebase apps, mock UIDs, independent registry/ledger and device-only keys. No production auth is read. */
export function developmentV2NativePair(host: unknown, port: unknown, run: unknown, role: unknown): Promise<DevelopmentV2NativePair> {
  const scope = v2PairScope(__DEV__, run, role); const endpoint = privateCalendarAuditEndpoint(host, port);
  const cacheKey = JSON.stringify([endpoint, scope]); const old = contexts.get(cacheKey); if (old) return old;
  const pending = (async () => {
    const tag = randomUUID(); const apps: ReturnType<typeof initializeApp>[] = []; const stores: ReturnType<typeof initializeFirestore>[] = [];
    let database: Awaited<ReturnType<typeof openSharingV2Database>> | undefined; let registry: typeof database; let pair: V2NativePair | undefined; let disposed = false;
    function client(uid: string, name: string) {
      const app = initializeApp({ projectId: V2_PAIR_PROJECT, apiKey: 'development-only-emulator', appId: 'development-v2-native-pair' }, `v2-pair-${tag}-${name}`); apps.push(app);
      const store = initializeFirestore(app, { experimentalForceLongPolling: true, experimentalAutoDetectLongPolling: false }); stores.push(store);
      connectFirestoreEmulator(store, endpoint.host, endpoint.port, { mockUserToken: { sub: uid } }); return store;
    }
    const dispose = async () => {
      if (disposed) return; disposed = true; pair?.close(); contexts.delete(cacheKey);
      try { await Promise.all([database, registry].filter(value => !!value).map(async value => { await drainPlannerDatabaseOperations(value); await value.closeAsync(); })); }
      finally { try { await Promise.all(stores.map(store => terminate(store))); } finally { await Promise.all(apps.map(app => deleteApp(app))); } }
    };
    try {
      const store = client(scope.userId, 'member'); const outsider = client(`${scope.groupId}-outsider`, 'outsider');
      const identity = await loadOrCreateSharingDeviceIdentity(scope.userId, 'development-native-pair');
      database = await openSharingV2Database(scope.userId, scope.groupId, 'development-native-pair');
      const registryName = `qa-v2-pair-registry-${bytesToHex(sha256(new TextEncoder().encode(scope.userId)))}.db`;
      registry = await openDatabaseAsync(registryName, { useNewConnection: true }, await sharingDatabaseDirectory());
      pair = await createV2NativePair({ development: __DEV__, projectId: V2_PAIR_PROJECT, run: scope.run, role: scope.role as V2PairRole,
        database, registry, identity, crypto: nativeSharingCrypto, cloud: createSharingCloud(store, scope.userId, () => disposed ? null : scope.userId),
        readKey: version => loadSharingGroupKey(scope.userId, scope.groupId, version), saveKey: (version, key) => saveSharingGroupKey(scope.userId, scope.groupId, version, key),
        serialized: work => withPlannerDatabaseOperation(database!, work), makeId: randomUUID, now: () => new Date(),
        invitationSeed: sha256(new TextEncoder().encode(`liflow-public-development-pair-invitation:${scope.run}`)) });
      return { ...pair, dispose,
        async network(enabled: boolean) { if (disposed) throw new Error('検査接続は閉じています。'); await (enabled ? enableNetwork(store) : disableNetwork(store)); },
        async assertOutsiderDenied() {
          try { await getDocFromServer(doc(outsider, 'sharingGroups', scope.groupId)); }
          catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'permission-denied') return; throw error; }
          throw new Error('別UIDの読取をRulesが拒否していません。');
        } };
    } catch (error) { await dispose(); throw error; }
  })();
  contexts.set(cacheKey, pending); void pending.catch(() => { if (contexts.get(cacheKey) === pending) contexts.delete(cacheKey); }); return pending;
}
