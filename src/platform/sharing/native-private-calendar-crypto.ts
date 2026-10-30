import { CryptoDigestAlgorithm, digest } from 'expo-crypto';
import type { PrivateCalendarCryptoGateway } from '../../features/sharing/private-calendar/crypto-gateway.ts';
import { nativeSharingCrypto } from './native-crypto';

/** Reuse Native AES/RNG, while large ciphertext hashes also run outside the JS implementation. */
export const nativePrivateCalendarCrypto: PrivateCalendarCryptoGateway = {
  ...nativeSharingCrypto,
  async digestSha256(bytes) { return new Uint8Array(await digest(CryptoDigestAlgorithm.SHA256, new Uint8Array(bytes))); },
};
