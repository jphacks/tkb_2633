import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect } from 'expo-router';
import { createV2ConfigurationEditorState } from './configuration-editor-state';
import type { V2EditorInput } from './configuration-editor-state';

/** Mount separately for each group/chore. Remote input synchronizes with the external draft store. */
export function useV2ConfigurationAutosave(input: V2EditorInput) {
  const [store] = useState(() => createV2ConfigurationEditorState(input));
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useEffect(() => { store.updateInput(input); }, [input, store]);
  useFocusEffect(useCallback(() => () => { void store.flush(); }, [store]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') void store.flush(); });
    return () => { subscription.remove(); void store.flush(); };
  }, [store]);
  return { ...store, ...snapshot, hasDraft: store.hasDraft };
}
