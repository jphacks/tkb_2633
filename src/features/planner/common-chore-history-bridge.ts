import type { PlannerSnapshot } from '../../platform/storage/repository';
import type { CommonCompletionSource } from './common-chore-links';

class ChangedSource extends Error {}
export function createCommonChoreHistoryBridge(input: {
  groupId: string; isCurrent(): boolean; read(): PlannerSnapshot | null; authorize(): Promise<unknown>;
  apply(source: CommonCompletionSource, guard: () => Promise<void>): Promise<number>; afterChange(changed: boolean): Promise<void>;
}) {
  let running: Promise<void> | undefined;
  let live = true;
  const current = () => live && input.isCurrent();
  const authorize = async () => {
    if (!current()) throw new Error('共有グループ・アカウントが変わりました。');
    await input.authorize();
    if (!current()) throw new Error('共有グループ・アカウントが変わりました。');
  };
  return { matches: current, authorize, activate() { live = true; }, deactivate() { live = false; },
    sync() {
      if (running) return running;
      const work = async () => {
        let changed = false;
        try {
          for (let attempt = 0; attempt < 4; attempt++) {
            await authorize(); const snapshot = input.read(); if (!snapshot) return;
            if (snapshot.sharing?.groupId !== input.groupId) throw new Error('共通の家事の保存先を確認できません。');
            const guard = async () => { await authorize(); if (input.read() !== snapshot) throw new ChangedSource(); };
            try {
              changed = Boolean(await input.apply({ groupId: input.groupId, chores: snapshot.chores, completions: snapshot.completions }, guard)) || changed;
              if (input.read() === snapshot) return;
            } catch (cause) { if (!(cause instanceof ChangedSource)) throw cause; }
          }
          throw new Error('家事が更新されています。個人側への反映を再試行してください。');
        } finally { if (current()) await input.afterChange(changed); }
      };
      const pending = work(); running = pending;
      void pending.finally(() => { if (running === pending) running = undefined; }).catch(() => {});
      return pending;
    } };
}
