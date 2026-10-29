import type { LoadOrder } from '../../domain/scheduling/task-priority';
export const HOME_LOAD_ORDER_KEY = 'liflow.home.load-order.v1';

/** Device-only presentation preference; never writes a household or sync operation. */
export function createHomeDisplayStore(storage: { getItemSync(key: string): string | null; setItemSync(key: string, value: string): void }) {
  let state: { order: LoadOrder; error: string | null } = { order: 'heavy', error: null };
  try { if (storage.getItemSync(HOME_LOAD_ORDER_KEY) === 'light') state.order = 'light'; }
  catch { state.error = '表示順を読み込めませんでした。重い順で表示しています。'; }
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; },
    toggle() {
      const order = state.order === 'heavy' ? 'light' : 'heavy';
      try { storage.setItemSync(HOME_LOAD_ORDER_KEY, order); state = { order, error: null }; }
      catch { state = { ...state, error: '表示順を保存できませんでした。もう一度お試しください。' }; }
      for (const listener of listeners) try { listener(); } catch { /* Display observers cannot invalidate a saved preference. */ }
    },
  };
}
