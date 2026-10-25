const listeners = new Set<() => boolean | void>();

export function subscribeToGooglePlannerChanges(listener: () => boolean | void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function notifyGooglePlannerChanges(): boolean {
  let handled = false;
  for (const listener of listeners) {
    try { handled = listener() === true || handled; } catch { /* A view refresh must not invalidate saved completions. */ }
  }
  return handled;
}
