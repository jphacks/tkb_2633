import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { AppState } from 'react-native';
import { useFocusEffect, usePreventRemove } from 'expo-router';
import type { AutosaveState } from '../../settings/autosave-queue';

/** Common leave/background handling for both cadence and text/choice editors. */
export function useV2DraftLifecycle<Snapshot extends { removalAllowed: boolean; hasDraft: boolean; status: AutosaveState }>(store: {
  subscribe: (listener: () => void) => () => void; getSnapshot: () => Snapshot; flush: () => Promise<boolean>;
  resumeNavigation: () => void; navigateAfterSave: (navigate: () => void) => Promise<boolean>;
}) {
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  useFocusEffect(useCallback(() => { store.resumeNavigation(); return () => { void store.flush(); }; }, [store]));
  const disablePrevention = usePreventRemove(!snapshot.removalAllowed && (snapshot.hasDraft || snapshot.status.phase === 'saving' || snapshot.status.phase === 'pending'),
    ({ repeat }) => { void store.navigateAfterSave(repeat); });
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => { if (state !== 'active') void store.flush(); });
    return () => { subscription.remove(); void store.flush(); };
  }, [store]);
  return { snapshot, navigateAfterSave: (navigate: () => void) => store.navigateAfterSave(() => { disablePrevention(); navigate(); }) };
}
