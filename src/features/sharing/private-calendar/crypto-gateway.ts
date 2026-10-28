import type { SharingCryptoGateway } from '../crypto.ts';

/** Optional acceleration has exactly the same SHA-256 bytes as the portable implementation. */
export interface PrivateCalendarCryptoGateway extends SharingCryptoGateway {
  digestSha256?(bytes: Uint8Array): Promise<Uint8Array>;
}
