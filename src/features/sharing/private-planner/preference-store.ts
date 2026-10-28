import { assertSharedIdentifier } from '../identifier.ts';
import { snapshotPrivatePlannerPreferences, snapshotSavedPrivatePlannerPreferences } from './preferences.ts';
import type { PrivatePlannerPreferences, SavedPrivatePlannerPreferences } from './preferences.ts';

export interface PrivatePlannerPreferencePort {
  ownerUserId: string;
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  assertOwner(userId: string): void | Promise<void>;
  exclusive<T>(userId: string, work: () => Promise<T>): Promise<T>;
  afterSave?(): void;
}
export class PrivatePlannerPreferenceConflict extends Error {
  constructor() { super('本人の設定が別の操作で更新されています。保存済みの内容を再読込して確認してください。'); this.name = 'PrivatePlannerPreferenceConflict'; }
}
/** Per-UID protected local storage. This does not claim remote acceptance or cross-device synchronization. */
export function createPrivatePlannerPreferenceStore(port: PrivatePlannerPreferencePort) {
  const { ownerUserId, vault } = port; assertSharedIdentifier(ownerUserId); const key = `private-planner-preferences:${ownerUserId}`;
  async function saved() {
    await port.assertOwner(ownerUserId); const raw = await vault.getItem(key); await port.assertOwner(ownerUserId);
    if (raw === null) return null;
    if (typeof raw !== 'string' || raw.length > 16_384) throw new Error('本人の保存済み設定を確認できません。');
    return snapshotSavedPrivatePlannerPreferences(JSON.parse(raw), ownerUserId);
  }
  async function read() {
    await port.assertOwner(ownerUserId); const value = await port.exclusive(ownerUserId, saved); await port.assertOwner(ownerUserId); return value;
  }
  return { read,
    async save(expectedRevision: number, input: PrivatePlannerPreferences) {
      const own = snapshotPrivatePlannerPreferences(input);
      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error('保存する設定の版を確認してください。');
      await port.assertOwner(ownerUserId); let prepared: SavedPrivatePlannerPreferences | null = null;
      const same = (value: SavedPrivatePlannerPreferences) => JSON.stringify({ timeZone: value.timeZone, restDays: value.restDays, loadLimits: value.loadLimits, allowedBands: value.allowedBands }) === JSON.stringify(own);
      let result: SavedPrivatePlannerPreferences;
      try {
        result = await port.exclusive(ownerUserId, async () => {
          const before = await saved();
          if ((before?.revision ?? 0) !== expectedRevision) {
            if (before && before.revision === expectedRevision + 1 && same(before)) return before;
            throw new PrivatePlannerPreferenceConflict();
          }
          if (before && same(before)) return before;
          prepared = { schemaVersion: 1, ownerUserId, revision: expectedRevision + 1, ...own };
          await port.assertOwner(ownerUserId); await vault.setItem(key, JSON.stringify(prepared)); await port.assertOwner(ownerUserId); return prepared;
        });
      } catch (error) {
        // Keychain can commit before its reply or the SQL lock response is lost. Re-read, never replay the write.
        if (!prepared) throw error;
        let recovered;
        try { recovered = await read(); } catch { throw error; }
        if (!recovered || JSON.stringify(recovered) !== JSON.stringify(prepared)) throw error;
        result = recovered;
      }
      await port.assertOwner(ownerUserId);
      try { if (prepared) port.afterSave?.(); } catch { /* A subscriber cannot roll back protected storage. */ }
      return result;
    },
  };
}
export type PrivatePlannerPreferenceStore = ReturnType<typeof createPrivatePlannerPreferenceStore>;
