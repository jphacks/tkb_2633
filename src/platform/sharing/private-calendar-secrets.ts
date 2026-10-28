import * as SecureStore from 'expo-secure-store';
import { createSecureVault } from '../../features/sharing/secure-vault.ts';
import { assertPrivateCalendarProtectedAuthority, createPrivateCalendarSecretStore, readPrivateCalendarProtectedDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import { createPrivateCalendarExclusiveStorage } from '../storage/private-calendar-store.ts';
import { createPrivateCalendarCacheStorage } from '../storage/private-calendar-cache.ts';
import { createPrivateCalendarRootSetupStorage } from '../storage/private-calendar-root-setup.ts';
import { createPrivateCalendarAuthorityIntentStorage } from '../storage/private-calendar-authority-intents.ts';
import { createPrivateCalendarKeyOutbox } from '../storage/private-calendar-key-outbox.ts';
import { createPrivateCalendarPairingStorage } from '../storage/private-calendar-pairing.ts';
import { createPrivateCalendarSourceStorage } from '../storage/private-calendar-source.ts';
import { createPrivatePlannerPreferenceStore } from '../../features/sharing/private-planner/preference-store.ts';
import type { SQLiteDatabase } from 'expo-sqlite';
import { getSharingServices } from './firebase-services.ts';
import { openPrivateCalendarDatabase } from './database-location';
import { nativePrivateCalendarCrypto } from './native-private-calendar-crypto';

function nativeStore(development: boolean) {
  const options: SecureStore.SecureStoreOptions = { keychainService: development
    ? 'jp.jphacks.tkb2633.private-calendar.qa' : 'jp.jphacks.tkb2633.private-calendar',
  // Each device must be approved; a backup must not silently clone an approved private identity.
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };
  const vault = createSecureVault({ get: (key) => SecureStore.getItemAsync(key, options), set: (key, value) => SecureStore.setItemAsync(key, value, options),
    remove: (key) => SecureStore.deleteItemAsync(key, options) }, nativePrivateCalendarCrypto.randomBytes);
  const stores = new Map<string, Promise<ReturnType<typeof createPrivateCalendarExclusiveStorage>>>();
  const assertOwner = (userId: string) => {
    if (development ? !__DEV__ || !userId.startsWith('development-calendar-') : getSharingServices().auth.currentUser?.uid !== userId) throw new Error('本人用Calendarのアカウントが変わりました。');
  };
  async function exclusive<T>(userId: string, work: (transaction: SQLiteDatabase) => Promise<T>): Promise<T> {
    assertOwner(userId); let pending = stores.get(userId);
    if (!pending) {
      pending = openPrivateCalendarDatabase(userId, development).then(createPrivateCalendarExclusiveStorage); stores.set(userId, pending);
      void pending.catch(() => { if (stores.get(userId) === pending) stores.delete(userId); });
    }
    const store = await pending; assertOwner(userId); return store.exclusive(userId, work);
  }
  const secrets = createPrivateCalendarSecretStore({ vault, crypto: nativePrivateCalendarCrypto, assertOwner, exclusive });
  function cache(userId: string) {
    assertOwner(userId);
    return createPrivateCalendarCacheStorage({ ownerUserId: userId, crypto: nativePrivateCalendarCrypto, assertOwner, exclusive,
      async assertAuthority(authority, requireMain) {
        const raw = await vault.getItem(`private-calendar-state:${userId}`); assertOwner(userId);
        assertPrivateCalendarProtectedAuthority(raw, userId, authority, requireMain);
      } });
  }
  function protectedPort(userId: string) {
    assertOwner(userId);
    return { ownerUserId: userId, assertOwner, exclusive,
      async readProtected() {
        const raw = await vault.getItem(`private-calendar-state:${userId}`); assertOwner(userId);
        return readPrivateCalendarProtectedDeviceState(raw, userId);
      } };
  }
  function rootSetup(userId: string) {
    return createPrivateCalendarRootSetupStorage({ ...protectedPort(userId), crypto: nativePrivateCalendarCrypto });
  }
  function authorityIntents(userId: string) {
    return createPrivateCalendarAuthorityIntentStorage(protectedPort(userId));
  }
  function keyOutbox(userId: string) {
    return createPrivateCalendarKeyOutbox({ ...protectedPort(userId), crypto: nativePrivateCalendarCrypto });
  }
  function pairing(userId: string) {
    return createPrivateCalendarPairingStorage({ ...protectedPort(userId), crypto: nativePrivateCalendarCrypto, vault });
  }
  function source(userId: string) { return createPrivateCalendarSourceStorage({ ...protectedPort(userId), vault }); }
  function preferences(userId: string) {
    assertOwner(userId);
    return createPrivatePlannerPreferenceStore({ ownerUserId: userId, vault, assertOwner,
      exclusive: (owner, work) => exclusive(owner, () => work()) });
  }
  return { secrets, cache, rootSetup, authorityIntents, keyOutbox, pairing, source, preferences };
}

/** Importing this module does not initialize Firebase or open any user's database. */
const native = nativeStore(false);
export const nativePrivateCalendarSecrets = native.secrets;
export const nativePrivateCalendarCache = native.cache;
export const nativePrivateCalendarRootSetup = native.rootSetup;
export const nativePrivateCalendarAuthorityIntents = native.authorityIntents;
export const nativePrivateCalendarKeyOutbox = native.keyOutbox;
export const nativePrivateCalendarPairing = native.pairing;
export const nativePrivateCalendarSource = native.source;
export const nativePrivatePlannerPreferences = native.preferences;
let qaStore: ReturnType<typeof nativeStore> | undefined;
export function developmentPrivateCalendarSecrets() {
  if (!__DEV__) throw new Error('検査用の鍵保存は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).secrets;
}
export function developmentPrivateCalendarCache(userId: string) {
  if (!__DEV__) throw new Error('検査用のCalendar保存は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).cache(userId);
}
export function developmentPrivateCalendarRootSetup(userId: string) {
  if (!__DEV__) throw new Error('検査用の初回設定は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).rootSetup(userId);
}
export function developmentPrivateCalendarAuthorityIntents(userId: string) {
  if (!__DEV__) throw new Error('検査用の本人端末の変更は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).authorityIntents(userId);
}
export function developmentPrivateCalendarKeyOutbox(userId: string) {
  if (!__DEV__) throw new Error('検査用の鍵配布は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).keyOutbox(userId);
}
export function developmentPrivateCalendarPairing(userId: string) {
  if (!__DEV__) throw new Error('検査用の本人端末の承認は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).pairing(userId);
}
export function developmentPrivateCalendarSource(userId: string) {
  if (!__DEV__) throw new Error('検査用のCalendar取得元は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).source(userId);
}
export function developmentPrivatePlannerPreferences(userId: string) {
  if (!__DEV__) throw new Error('検査用の本人設定は開発ビルドだけで使用できます。');
  return (qaStore ??= nativeStore(true)).preferences(userId);
}
