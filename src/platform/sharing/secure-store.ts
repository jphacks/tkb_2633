import * as SecureStore from 'expo-secure-store';
import { createSecureVault } from '../../features/sharing/secure-vault.ts';
import { createDeviceIdentity, validateDeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { assertSharedIdentifier } from '../../features/sharing/operations.ts';
import { nativeSharingCrypto } from './native-crypto.ts';

const options: SecureStore.SecureStoreOptions = {
  keychainService: 'jp.jphacks.tkb2633.sharing',
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};
export const sharingSecureVault = createSecureVault({
  get: (key) => SecureStore.getItemAsync(key, options),
  set: (key, value) => SecureStore.setItemAsync(key, value, options),
  remove: (key) => SecureStore.deleteItemAsync(key, options),
}, nativeSharingCrypto.randomBytes);

const pendingIdentities = new Map<string, Promise<DeviceSecretIdentity>>();
export function loadOrCreateSharingDeviceIdentity(userId: string): Promise<DeviceSecretIdentity> {
  assertSharedIdentifier(userId);
  const existing = pendingIdentities.get(userId); if (existing) return existing;
  const pending = (async () => {
    const key = `device-identity:${userId}`;
    const saved = await sharingSecureVault.getItem(key);
    if (saved) return validateDeviceSecretIdentity(JSON.parse(saved));
    const identity = await createDeviceIdentity(nativeSharingCrypto);
    // Do not expose a device public key until the matching private keys have been saved.
    await sharingSecureVault.setItem(key, JSON.stringify(identity));
    return identity;
  })();
  pendingIdentities.set(userId, pending);
  void pending.finally(() => { if (pendingIdentities.get(userId) === pending) pendingIdentities.delete(userId); }).catch(() => undefined);
  return pending;
}

export async function saveSharingGroupKey(userId: string, groupId: string, keyVersion: number, bytes: Uint8Array): Promise<void> {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1 || bytes.length !== 32) throw new Error('Invalid group key');
  const encoded = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  await sharingSecureVault.setItem(`group-key:${userId}:${groupId}:${keyVersion}`, encoded);
}

export async function loadSharingGroupKey(userId: string, groupId: string, keyVersion: number): Promise<Uint8Array | null> {
  assertSharedIdentifier(userId); assertSharedIdentifier(groupId);
  if (!Number.isSafeInteger(keyVersion) || keyVersion < 1) throw new Error('Invalid group key version');
  const saved = await sharingSecureVault.getItem(`group-key:${userId}:${groupId}:${keyVersion}`);
  if (saved === null) return null;
  if (!/^[a-f0-9]{64}$/u.test(saved)) throw new Error('Invalid saved group key');
  return new Uint8Array(saved.match(/../gu)!.map((part) => parseInt(part, 16)));
}
