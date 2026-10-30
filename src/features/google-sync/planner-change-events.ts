const listeners = new Map<() => boolean | void, string>();

export function subscribeToGooglePlannerChanges(listener: () => boolean | void, scope = 'personal'): () => void {
  listeners.set(listener, scope);
  return () => { listeners.delete(listener); };
}

export function notifyGooglePlannerChanges(scope = 'personal'): boolean {
  let handled = false;
  for (const [listener, subscribedScope] of listeners) {
    if (subscribedScope !== scope) continue;
    try { handled = listener() === true || handled; } catch { /* A view refresh must not invalidate saved completions. */ }
  }
  return handled;
}
