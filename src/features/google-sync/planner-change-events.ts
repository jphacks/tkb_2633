const listeners = new Set<() => void>();

export function subscribeToGooglePlannerChanges(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyGooglePlannerChanges(): void {
  for (const listener of listeners) {
    try { listener(); } catch { /* A view refresh must not invalidate saved completions. */ }
  }
}
