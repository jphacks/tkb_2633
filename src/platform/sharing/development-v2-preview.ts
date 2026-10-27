import { randomUUID } from 'expo-crypto';
import { nativeSharingCrypto } from './native-crypto';
import { openSharingDatabase } from './database-location';
import { createV2DevelopmentPreview } from '../../features/sharing/development/v2-preview-session';
import type { V2DevelopmentPreview } from '../../features/sharing/development/v2-preview-session';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema';

// The fixture read API now supports calendar months and focused historical rounds.
const symbol = Symbol.for(`LiFlow.developmentV2Preview.personal-model-3.${V2_SCHEDULER_VERSION}`);
type PreviewGlobal = typeof globalThis & { [key: symbol]: Promise<V2DevelopmentPreview> | undefined };

/** Reuse a single isolated fixture through navigation/Fast Refresh; never open it in a release build. */
export function developmentV2Preview(): Promise<V2DevelopmentPreview> {
  if (!__DEV__) return Promise.reject(new Error('Development preview is unavailable'));
  const host = globalThis as PreviewGlobal;
  if (!host[symbol]) {
    const pending = createV2DevelopmentPreview({ development: true, crypto: nativeSharingCrypto, makeId: randomUUID, now: () => new Date(),
      openDatabase: async (userId, groupId) => { const database = await openSharingDatabase(userId, groupId, 'development-v2-preview');
        return { database, close: () => database.closeAsync() }; } });
    host[symbol] = pending; void pending.catch(() => { if (host[symbol] === pending) host[symbol] = undefined; });
  }
  return host[symbol]!;
}
