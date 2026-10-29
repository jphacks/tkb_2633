import { useEffect, useMemo, useSyncExternalStore } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';
import { completeChore, undoCompletedChore } from '../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '../features/google-sync/coordinator';
import { createTaskMutations } from '../features/planner/task-mutations';

export function useTaskCompletion(database: SQLiteDatabase, refresh: () => Promise<void>, readError?: () => string | null) {
  const binding = useMemo(() => {
    const controller = createTaskMutations({
      isCurrent: () => true,
      write: async task => {
        const changed = task.completed ? await undoCompletedChore(database, task.completion!.id) : await completeChore(database, task.entry!);
        if (changed) syncGoogleTasksAfterLocalCompletion(database);
      },
      refresh: async () => { await refresh(); const error = readError?.(); if (error) throw new Error(error); },
    });
    return controller;
  }, [database, refresh, readError]);
  useEffect(() => { binding.activate(); return binding.deactivate; }, [binding]);
  const state = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  return { ...state, ...binding };
}
