import { useCallback, useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { SharedWorkspace } from '../platform/sharing/workspaces';
import type { usePlannerData } from './use-planner-data';
import { mirrorSharedChoreCompletions } from '../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '../features/google-sync/coordinator';
import { createCommonChoreHistoryBridge } from '../features/planner/common-chore-history-bridge';

type PlannerData = ReturnType<typeof usePlannerData>;
const inactiveBridge = { matches: () => false, authorize: async () => { throw new Error('共有グループを開いてください。'); }, sync: async () => {}, activate() {}, deactivate() {} };

/** Group facts are the durable retry source. No private content is staged in a shared Outbox. */
export function useCommonChoreHistory({ workspace, userId, shared, personal }: {
  workspace: SharedWorkspace | null; userId: string | null; shared: PlannerData; personal: PlannerData;
}) {
  const [error, setError] = useState<string | null>(null);
  const read = shared.readSnapshot; const personalDatabase = personal.database; const refreshPersonal = personal.refresh;
  const readPersonalError = personal.readError;
  const bridge = useMemo(() => workspace ? createCommonChoreHistoryBridge({
    groupId: workspace.groupId,
    isCurrent: () => userId === workspace.userId,
    read,
    authorize: () => workspace.record(),
    apply: (source, guard) => mirrorSharedChoreCompletions(personalDatabase, source, guard),
    afterChange: async changed => {
      if (changed) syncGoogleTasksAfterLocalCompletion(personalDatabase);
      // A previous attempt may have committed before its read failed. Retry the read even for a no-op replay.
      await refreshPersonal(); const failure = readPersonalError?.(); if (failure) throw new Error(failure);
    },
  }) : inactiveBridge, [workspace, userId, read, personalDatabase, refreshPersonal, readPersonalError]);
  useLayoutEffect(() => { bridge.activate(); return bridge.deactivate; }, [bridge]);
  const sync = useCallback(async () => {
    try { await bridge.sync(); if (bridge.matches()) setError(null); }
    catch (cause) {
      if (bridge.matches()) setError('グループの状態は保存済みです。個人側への反映を再試行してください。');
      throw cause;
    }
  }, [bridge]);
  const definitions = JSON.stringify(personal.snapshot?.chores.map(chore => [chore.id, chore.name, chore.enabled, chore.archived]));
  useEffect(() => {
    if (workspace && shared.snapshot) void bridge.sync().then(
      () => { if (bridge.matches()) setError(null); },
      () => { if (bridge.matches()) setError('グループの状態は保存済みです。個人側への反映を再試行してください。'); },
    );
  }, [workspace, shared.snapshot, definitions, bridge]);
  return { sync, error, isCurrent: bridge.matches, assertAccess: bridge.authorize };
}
