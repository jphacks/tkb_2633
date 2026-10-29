import type { DateTask } from '../../domain/scheduling/date-tasks';

export const dateTaskKey = (task: DateTask) => task.completion?.scheduleEntryId ?? task.entry?.id ?? task.id;

/** An immediate view overlay, never a second source of stored completion history. */
export function createTaskMutations(dependencies: {
  write(task: DateTask): Promise<unknown>;
  refresh(): Promise<void>;
  isCurrent(): boolean;
}) {
  let live = true;
  const current = () => live && dependencies.isCurrent();
  let state = { overrides: new Map<string, boolean>(), pending: new Set<string>(), error: null as string | null };
  const listeners = new Set<() => void>();
  const emit = () => { for (const fn of listeners) try { fn(); } catch { /* A failed view observer cannot prevent a stored change. */ } };
  return {
    activate: () => { live = true; }, deactivate: () => { live = false; },
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    project(tasks: readonly DateTask[]) { return tasks.map(task => state.overrides.has(dateTaskKey(task))
      ? { ...task, completed: state.overrides.get(dateTaskKey(task))! } : task); },
    async toggle(task: DateTask) {
      const key = dateTaskKey(task);
      if (!current() || state.pending.has(key) || (task.completed ? !task.completion : !task.entry)) return;
      state = { overrides: new Map(state.overrides).set(key, !task.completed), pending: new Set(state.pending).add(key), error: null }; emit();
      let saved = false;
      try {
        await dependencies.write(task); saved = true;
        if (!current()) return;
        await dependencies.refresh();
        if (!current()) return;
        const overrides = new Map(state.overrides); overrides.delete(key);
        state = { ...state, overrides };
      } catch (cause) {
        if (!current()) return;
        const overrides = new Map(state.overrides);
        // A failed read must not undo a successful write on screen or repeat that write.
        if (!saved) overrides.delete(key);
        state = { ...state, overrides, error: saved
          ? '保存済みですが、表示を更新できませんでした。再読込してください。'
          : cause instanceof Error ? cause.message : '保存できませんでした。もう一度お試しください。' };
      } finally {
        if (current()) { const pending = new Set(state.pending); pending.delete(key); state = { ...state, pending }; emit(); }
      }
    },
    async retryRead() {
      if (!current() || state.pending.size) return;
      try { await dependencies.refresh(); if (current()) { state = { ...state, overrides: new Map(), error: null }; emit(); } }
      catch { /* Retain the saved overlay and its retry message. */ }
    },
  };
}
