import type { V2PersonalCopyStore, V2PersonalCopyControl } from '../../../platform/storage/sharing-v2-personal-copy';
import type { V2PersonalCopyContext, V2PersonalCopySource } from './personal-copy';

export interface V2PersonalCopyChoice { id: string; name: string; enabled: boolean; requiresCycleSelection: boolean }
export interface V2PersonalCopyScreenState {
  context: V2PersonalCopyContext | null; control: V2PersonalCopyControl; choices: V2PersonalCopyChoice[];
}
/** The source is read only after an explicit copy action or initial chooser load; never a cloud or OAuth operation. */
export function createV2PersonalCopyRuntime(input: { userId: string; groupId: string; store: V2PersonalCopyStore;
  assertAccess(): void | Promise<void>; readSource(ids?: readonly string[]): Promise<V2PersonalCopySource> }) {
  if (input.store.scope.userId !== input.userId || input.store.scope.groupId !== input.groupId) throw new Error('本人と共有グループのコピー確認先を確認してください。');
  let running = false;
  const guard = async () => { await input.assertAccess(); };
  const administrator = (context: V2PersonalCopyContext | null) => {
    if (!context || context.userId !== input.userId || context.groupId !== input.groupId || context.administratorUserId !== input.userId) throw new Error('有効状態と周期を含む設定のコピーは、共有グループの管理者が行います。');
  };
  async function mutate<T>(work: () => Promise<T>) {
    if (running) throw new Error('コピーの確認処理が終わるまでお待ちください。'); running = true;
    try { await guard(); const result = await work(); await guard(); return result; }
    finally { running = false; }
  }
  return {
    async load(): Promise<V2PersonalCopyScreenState> {
      await guard(); const control = await input.store.read(); await guard();
      let context: V2PersonalCopyContext | null;
      try { context = await input.store.readContext(); } catch { context = null; }
      await guard();
      if (control.review || !context || context.administratorUserId !== input.userId) return { context, control, choices: [] };
      administrator(context); const source = await input.readSource(); await guard();
      if (source.scope !== 'personal' || source.ownerUserId !== input.userId || source.householdId !== 'local-household'
        || source.chores.some(chore => chore.householdId !== source.householdId || typeof chore.id !== 'string' || typeof chore.name !== 'string' || typeof chore.enabled !== 'boolean')) throw new Error('本人の個人家事を確認してください。');
      return { context, control, choices: source.chores.filter(chore => !chore.archived).map(chore => ({ id: chore.id, name: chore.name, enabled: chore.enabled,
        requiresCycleSelection: chore.requiresCycleSelection === true })) };
    },
    prepare(revision: number, selected: readonly string[], preset: 'common' | 'eachMember') {
      const ids = [...selected];
      return mutate(async () => {
        administrator(await input.store.readContext()); await guard();
        const source = await input.readSource(ids); await guard();
        return input.store.prepare(revision, source, ids, preset);
      });
    },
    confirm(reference: { id: string; digest: string }) {
      const captured = { id: reference.id, digest: reference.digest };
      return mutate(async () => {
        const current = await input.store.read(); await guard();
        if (!current.review || current.review.id !== captured.id || current.review.digest !== captured.digest) throw new Error('確認したコピー内容を読み直してください。');
        if (current.status === 'committed') return input.store.confirm(captured);
        administrator(await input.store.readContext()); await guard();
        const source = await input.readSource(current.review.records.map(record => record.personalChoreId)); await guard();
        return input.store.confirm(captured, source);
      });
    },
    clear: (revision: number) => mutate(() => input.store.clear(revision)),
  };
}
export type V2PersonalCopyRuntime = ReturnType<typeof createV2PersonalCopyRuntime>;
