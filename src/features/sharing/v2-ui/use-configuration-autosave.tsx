import { useEffect, useState } from 'react';
import { createV2ConfigurationEditorState } from './configuration-editor-state';
import type { V2EditorInput } from './configuration-editor-state';
import { useV2DraftLifecycle } from './use-draft-lifecycle';

/** Mount separately for each group/chore. Remote input synchronizes with the external draft store. */
export function useV2ConfigurationAutosave(input: V2EditorInput) {
  const [store] = useState(() => createV2ConfigurationEditorState(input));
  useEffect(() => { store.updateInput(input); }, [input, store]);
  const { snapshot, navigateAfterSave } = useV2DraftLifecycle(store);
  return { ...store, ...snapshot, hasDraft: store.hasDraft, navigateAfterSave };
}
