import { openDatabaseAsync } from 'expo-sqlite';
import { randomUUID } from 'expo-crypto';
import type { createV2EventRepository } from '../storage/sharing-v2-events';
import { readPersonalChoreCopySource } from '../storage/repository';
import { createV2PersonalCopyStore } from '../storage/sharing-v2-personal-copy';
import { createV2PersonalCopyRuntime } from '../../features/sharing/v2/personal-copy-runtime';

/** UI-lifetime guard also fences a source read that finishes after its screen or workspace changed. */
export function createNativeV2PersonalCopy(input: { repository: ReturnType<typeof createV2EventRepository>; userId: string; groupId: string;
  assertAccess(): void | Promise<void> }) {
  const store = createV2PersonalCopyStore({ ...input, makeId: randomUUID, now: () => new Date() });
  return createV2PersonalCopyRuntime({ ...input, store,
    async readSource(ids) {
      await input.assertAccess(); const database = await openDatabaseAsync('housework.db', { useNewConnection: true });
      try {
        await input.assertAccess(); const source = await readPersonalChoreCopySource(database, ids); await input.assertAccess();
        if (source.householdId !== 'local-household') throw new Error('本人の個人設定の保存先を確認してください。');
        return { ...source, scope: 'personal' as const, ownerUserId: input.userId };
      } finally { await database.closeAsync(); }
    },
  });
}
