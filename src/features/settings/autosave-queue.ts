export interface AutosaveState {
  phase: 'idle' | 'pending' | 'saving' | 'saved' | 'error';
  error: string | null;
}

/** One writer, merged pending edits, and explicit flushing for blur/navigation/background. */
export function createAutosaveQueue<Patch extends object>({ save, delayMs = 450 }: {
  save: (patch: Patch) => Promise<unknown>;
  delayMs?: number;
}) {
  let pending: Partial<Patch> = {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<boolean> | undefined;
  let state: AutosaveState = { phase: 'idle', error: null };
  const listeners = new Set<() => void>();
  const discarded = new Set<keyof Patch>();
  const hasPending = () => Object.keys(pending).length > 0;
  const publish = (phase: AutosaveState['phase'], error: string | null = null) => {
    state = { phase, error };
    for (const listener of listeners) listener();
  };
  const flush = (): Promise<boolean> => {
    clearTimeout(timer);
    if (running) return running;
    if (!hasPending()) return Promise.resolve(true);
    running = (async () => {
      while (hasPending()) {
        const batch = pending as Patch;
        pending = {};
        publish('saving');
        try { await save(batch); }
        catch (cause) {
          // An input cleared while this write ran must not reappear in a retry.
          const retry = Object.fromEntries(Object.entries(batch).filter(([key]) => !discarded.has(key as keyof Patch))) as Partial<Patch>;
          pending = { ...retry, ...pending };
          if (!hasPending()) { publish('idle'); return true; }
          publish('error', cause instanceof Error ? cause.message : '設定を保存できませんでした。');
          return false;
        }
      }
      publish('saved');
      return true;
    })().finally(() => { running = undefined; });
    return running;
  };
  return {
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    enqueue(patch: Partial<Patch>, immediate = false) {
      for (const key of Object.keys(patch)) discarded.delete(key as keyof Patch);
      pending = { ...pending, ...patch };
      clearTimeout(timer);
      if (!running) publish('pending');
      if (immediate) void flush();
      else timer = setTimeout(() => { void flush(); }, delayMs);
    },
    remove(key: keyof Patch) {
      discarded.add(key);
      delete pending[key];
      if (!hasPending() && !running) { clearTimeout(timer); publish('idle'); }
    },
    flush,
  };
}
