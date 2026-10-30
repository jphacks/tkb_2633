import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import type { SQLiteDatabase } from 'expo-sqlite';
import { completeChoreWithReceipt, undoCompletionReceipt, undoCompletedChore } from '../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '../features/google-sync/coordinator';
import { createTaskMutations, scopedDateTaskKey } from '../features/planner/task-mutations';
import type { DateTask } from '../domain/scheduling/date-tasks';
import { sharedRepositoryAdapter } from '../platform/storage/shared-repository-adapter';

interface PersonalCompletionSource { database: SQLiteDatabase; refresh(): Promise<void>; readError?: () => string | null;
  isCurrent?: () => boolean; assertAccess?: (task?: DateTask) => void | Promise<void> }

export function useTaskCompletion(database: SQLiteDatabase, refresh: () => Promise<void>, readError?: () => string | null,
  personal?: PersonalCompletionSource) {
  const personalDatabase = personal?.database; const personalRefresh = personal?.refresh; const personalReadError = personal?.readError;
  const isCurrent = personal?.isCurrent; const assertPersonalAccess = personal?.assertAccess;
  const binding = useMemo(() => {
    const primary: PersonalCompletionSource = { database, refresh, readError };
    const secondary = personalDatabase && personalRefresh ? { database: personalDatabase, refresh: personalRefresh, readError: personalReadError, assertAccess: assertPersonalAccess } : undefined;
    const target = (task: DateTask) => secondary && task.completionScope === 'personal' ? secondary : primary;
    const controller = createTaskMutations({
      isCurrent: isCurrent ?? (() => true),
      key: secondary ? scopedDateTaskKey : undefined,
      write: async task => {
        const source = target(task);
        const guard = source.assertAccess ? () => source.assertAccess!(task) : undefined;
        const changed = task.completed ? await undoCompletedChore(source.database, task.completion!.id, guard) : await completeChoreWithReceipt(source.database, task.entry!, guard);
        if (changed) syncGoogleTasksAfterLocalCompletion(source.database);
        if (changed && typeof changed === 'object') return {
          undoTask: { ...task, completed: true, completion: changed },
          keepChecked: Boolean(sharedRepositoryAdapter(source.database)),
          undo: async () => { const undone = await undoCompletionReceipt(source.database, changed, guard); if (undone) syncGoogleTasksAfterLocalCompletion(source.database); return undone; },
        };
      },
      refresh: async task => {
        const sources = task ? [target(task)] : secondary ? [primary, secondary] : [primary];
        await Promise.all(sources.map(async source => { await source.refresh(); const error = source.readError?.(); if (error) throw new Error(error); }));
      },
    });
    return controller;
  }, [database, refresh, readError, personalDatabase, personalRefresh, personalReadError, isCurrent, assertPersonalAccess]);
  useEffect(() => { binding.activate(); return binding.deactivate; }, [binding]);
  useFocusEffect(useCallback(() => () => binding.dismissUndo(), [binding]));
  const state = useSyncExternalStore(binding.subscribe, binding.getSnapshot, binding.getSnapshot);
  return { ...state, ...binding };
}
