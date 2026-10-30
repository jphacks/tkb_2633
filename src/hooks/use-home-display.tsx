import { useSyncExternalStore } from 'react';
import Storage from 'expo-sqlite/kv-store';
import { createHomeDisplayStore } from '../features/planner/home-display-store';
let store: ReturnType<typeof createHomeDisplayStore> | undefined;
export function useHomeDisplay() {
  const binding = store ??= createHomeDisplayStore(Storage);
  return { ...useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot), toggle: binding.toggle };
}
