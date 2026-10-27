import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ActivityIndicator, AppState, Text } from 'react-native';
import { Card, Page, palette, typography } from '@/components/planner-ui';
import { PlannerDataProvider, usePlannerData } from './use-planner-data';
import { hasSharingSessionEnabled, knownSharingWorkspaces, openSharedWorkspace, readSharingSelection,
  saveSharingSelection, sharingSessionUser, subscribeSharingChanges, syncKnownSharingWorkspaces } from '@/platform/sharing/workspaces';
import type { SharedWorkspace, SharingSelection } from '@/platform/sharing/workspaces';
import type { SharingWorkspaceRecord } from '@/platform/storage/sharing-registry';
import { observeSharingUser } from '@/platform/sharing/auth';
import { drainPlannerDatabaseOperations } from '@/platform/storage/repository';
import { WorkspaceContext } from '@/contexts/workspace-context';
import type { WorkspaceContextValue } from '@/contexts/workspace-context';

/** The personal provider remains mounted for its widget and reminders; only the screen scope switches. */
export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const { database: personalDatabase } = usePlannerData();
  const [active, setActive] = useState<SharedWorkspace | null>(null);
  const activeRef = useRef<SharedWorkspace | null>(null);
  const [groups, setGroups] = useState<SharingWorkspaceRecord[]>([]);
  const [userId, setUserId] = useState<string | null>(null);
  const [sessionStarted, setSessionStarted] = useState(false);
  const [ready, setReady] = useState(false); const [error, setError] = useState<string | null>(null);
  const alive = useRef(true); const revision = useRef(0); const switchTail = useRef<Promise<unknown>>(Promise.resolve());
  const refreshSharing = useCallback(async () => {
    const current = ++revision.current; const user = await sharingSessionUser();
    const next = user ? await knownSharingWorkspaces() : [];
    if (!alive.current || revision.current !== current) return;
    setSessionStarted(true);
    setUserId(user?.uid ?? null); setGroups(next);
    if (activeRef.current && (!user || activeRef.current.userId !== user.uid
      || next.some((group) => group.groupId === activeRef.current!.groupId && ['left', 'removed'].includes(group.status)))) {
      activeRef.current = null; setActive(null);
    }
  }, []);
  const switchTo = useCallback((selection: SharingSelection | null): Promise<void> => {
    const work = async () => {
      if (activeRef.current) await activeRef.current.drain(); else await drainPlannerDatabaseOperations(personalDatabase);
      const next = selection ? await openSharedWorkspace(selection) : null;
      if (next?.protocol === null) throw new Error('参加承認と初回同期を完了してから切り替えてください。');
      await saveSharingSelection(selection);
      if (!alive.current) return;
      activeRef.current = next; setActive(next); setError(null); await refreshSharing();
    };
    const pending = switchTail.current.then(work, work); switchTail.current = pending.catch(() => undefined); return pending;
  }, [personalDatabase, refreshSharing]);
  useEffect(() => {
    alive.current = true;
    void (async () => {
      try {
        const selected = await readSharingSelection();
        if (selected || await hasSharingSessionEnabled()) {
          const user = await sharingSessionUser(); await refreshSharing();
          if (selected && user?.uid === selected.userId) {
            const record = (await knownSharingWorkspaces()).find((item) => item.groupId === selected.groupId);
            if (record && ['active', 'creating'].includes(record.status)) {
              const workspace = await openSharedWorkspace(selected); if (workspace.protocol === null) throw new Error('参加承認と初回同期を確認してください。');
              await workspace.readOverview();
              if (alive.current) { activeRef.current = workspace; setActive(workspace); }
            }
          }
        }
      } catch { if (alive.current) setError('共有グループを開けませんでした。設定の共有グループから同期・ログインを確認してください。'); }
      finally { if (alive.current) setReady(true); }
    })();
    const unsubscribe = subscribeSharingChanges(() => { void refreshSharing().catch(() => undefined); });
    return () => { alive.current = false; unsubscribe(); };
  }, [refreshSharing]);
  useEffect(() => {
    if (!sessionStarted) return;
    return observeSharingUser(() => { void refreshSharing().catch(() => undefined); });
  }, [refreshSharing, sessionStarted]);
  const groupKeys = groups.filter((group) => !['left', 'removed'].includes(group.status)).map((group) => JSON.stringify([group.userId, group.groupId, group.status,
    group.localGeneration, group.rosterArchive?.at(-1)?.body.schemaVersion, group.rosterArchive?.at(-1)?.body.schedulerVersion])).sort().join('|');
  useEffect(() => {
    if (!ready || !userId) return;
    let stopped = false; let generation = 0; let subscriptions: (() => void)[] = []; let interval: ReturnType<typeof setInterval> | undefined;
    const stop = () => { generation++; subscriptions.forEach((unsubscribe) => unsubscribe()); subscriptions = []; clearInterval(interval); };
    const start = async () => {
      stop(); const current = generation;
      const records = await knownSharingWorkspaces(); if (stopped || current !== generation || AppState.currentState !== 'active') return;
      for (const record of records.filter((group) => !['left', 'removed'].includes(group.status))) {
        if (stopped || current !== generation || AppState.currentState !== 'active') return;
        try {
          const workspace = await openSharedWorkspace(record); if (stopped || current !== generation || AppState.currentState !== 'active') return;
          // Permission revocation terminates a Firestore listener through its error callback.
          // Recheck membership there too; a network failure alone never proves removal.
          const synchronize = () => { void workspace.sync().catch(() => undefined); };
          subscriptions.push(workspace.watch(synchronize, synchronize));
        } catch { /* Keep other groups observable; the coordinator records/retries failures. */ }
      }
      if (stopped || current !== generation || AppState.currentState !== 'active') return;
      void syncKnownSharingWorkspaces().catch(() => undefined);
      interval = setInterval(() => { void syncKnownSharingWorkspaces().catch(() => undefined); }, 10 * 60_000);
    };
    if (AppState.currentState === 'active') void start().catch(() => undefined);
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') void start().catch(() => undefined); else stop();
    });
    return () => { stopped = true; stop(); subscription.remove(); };
  }, [groupKeys, ready, userId]);
  const value = useMemo(() => ({ active, groups, userId, ready, error, refreshSharing, switchTo }), [active, groups, userId, ready, error, refreshSharing, switchTo]);
  return <WorkspaceContext.Provider value={value}>{children}</WorkspaceContext.Provider>;
}

export function ActiveWorkspaceScope({ children }: { children: ReactNode }) {
  const context = useWorkspace();
  if (!context.ready) return <Page><Card><ActivityIndicator color={palette.accent} /><Text style={typography.body}>データを読み込んでいます。</Text></Card></Page>;
  return context.active?.protocol === 1 ? <PlannerDataProvider key={`${context.active.userId}:${context.active.groupId}`} databaseOverride={context.active.database}>{children}</PlannerDataProvider> : children;
}
export function useWorkspace(): WorkspaceContextValue {
  const context = useContext(WorkspaceContext); if (!context) throw new Error('WorkspaceProvider is required'); return context;
}
