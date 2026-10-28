import * as SecureStore from 'expo-secure-store';
import { createSecureVault } from '../../features/sharing/secure-vault.ts';
import { createPrivateCalendarSecretStore } from '../../features/sharing/private-calendar/secret-store.ts';
import { createPrivateCalendarExclusiveStorage } from '../storage/private-calendar-store.ts';
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
  return createPrivateCalendarSecretStore({ vault, crypto: nativePrivateCalendarCrypto, assertOwner,
    async exclusive(userId, work) {
      assertOwner(userId); let pending = stores.get(userId);
      if (!pending) {
        pending = openPrivateCalendarDatabase(userId, development).then(createPrivateCalendarExclusiveStorage); stores.set(userId, pending);
        void pending.catch(() => { if (stores.get(userId) === pending) stores.delete(userId); });
      }
      const store = await pending; assertOwner(userId); return store.exclusive(userId, work);
    } });
}

/** Importing this module does not initialize Firebase or open any user's database. */
export const nativePrivateCalendarSecrets = nativeStore(false);
let qaStore: ReturnType<typeof nativeStore> | undefined;
export function developmentPrivateCalendarSecrets() {
  if (!__DEV__) throw new Error('検査用の鍵保存は開発ビルドだけで使用できます。');
  return qaStore ??= nativeStore(true);
}
