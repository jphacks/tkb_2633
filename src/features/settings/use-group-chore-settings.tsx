import { useCallback, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { openSharedWorkspace, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import type { SharingSelection } from '../sharing/workspace-selection';
import { createGroupChoreSettingsSource } from './group-chore-settings-source';

export function useGroupChoreSettings(selection: SharingSelection) {
  const { userId, groupId } = selection;
  const source = useMemo(() => createGroupChoreSettingsSource({ userId, groupId }, openSharedWorkspace), [userId, groupId]);
  const state = useSyncExternalStore(source.subscribe, source.getSnapshot, source.getSnapshot);
  useFocusEffect(useCallback(() => {
    void source.refresh();
    const unsubscribe = subscribeSharingChanges(scope => { if (scope?.userId === userId && scope.groupId === groupId) void source.refresh(); });
    return () => { unsubscribe(); source.invalidate(); };
  }, [source, userId, groupId]));
  return { ...state, source };
}
