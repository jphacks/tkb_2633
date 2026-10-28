import { useCallback, useLayoutEffect, useRef } from 'react';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { AppButton, Card, Page, typography } from '../../../components/planner-ui';
import { Text } from 'react-native';
import { useWorkspace } from '../../../hooks/use-workspace';
import { usePlannerData } from '../../../hooks/use-planner-data';
import { V2GroupScreen } from './group-screen';
import type { V2GroupScreenProps } from './group-screen';
import { createV2ScreenSession } from './screen-session';
import type { Weekday } from '../../../domain/shared/types';
import { sharingFailureMessage, subscribeSharingChanges } from '@/platform/sharing/workspaces';
import { createV2PrivateTaskSource } from './private-overlay';
import { readPersonalPlannerOverlaySnapshot, setPersonalDateTaskCompleted } from '../../../platform/storage/repository';
import { syncGoogleTasksAfterLocalCompletion } from '@/features/google-sync/coordinator';

/** Only an explicitly selected, authenticated v2 workspace reaches these controls. */
export function V2WorkspaceRoute({ view }: { view: V2GroupScreenProps['view'] }) {
  const context = useWorkspace(); const { database: personalDatabase, snapshot: personalSnapshot, refresh: refreshPersonal } = usePlannerData(); const router = useRouter();
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string }>();
  const active = context.active?.protocol === 2 ? context.active : null;
  const current = useRef<{ active: typeof active; userId: string | null; database: typeof personalDatabase } | null>({ active, userId: context.userId, database: personalDatabase });
  useLayoutEffect(() => {
    current.current = { active, userId: context.userId, database: personalDatabase };
    return () => { current.current = null; };
  }, [active, context.userId, personalDatabase]);
  const subscribe = useCallback((changed: () => void) => subscribeSharingChanges((scope) => {
    if (active && scope?.userId === active.userId && scope.groupId === active.groupId) changed();
  }), [active]);
  const loadSession = useCallback(async () => {
    if (!active || context.userId !== active.userId) throw new Error('共有グループを選択してください。');
    await active.record();
    const assertPersonalAccess = async () => {
      const matches = () => current.current?.active === active && current.current.userId === active.userId && current.current.database === personalDatabase;
      if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
      await active.record();
      if (!matches()) throw new Error('個人家事を操作するアカウント・グループが変わりました。');
    };
    const privateTasks = createV2PrivateTaskSource({ ownerUserId: active.userId, assertAccess: assertPersonalAccess,
      readSnapshot: async (instant) => ({ ...await readPersonalPlannerOverlaySnapshot(personalDatabase, instant), ownerUserId: active.userId }),
      save: (command, guard) => setPersonalDateTaskCompleted(personalDatabase, command, guard),
      afterChange: async () => {
        await assertPersonalAccess(); syncGoogleTasksAfterLocalCompletion(personalDatabase);
        try { await refreshPersonal({ force: true }); }
        catch { throw new Error('個人家事は保存済みです。表示を更新するため再読込してください。'); }
      } });
    return createV2ScreenSession({ groupId: active.groupId, userId: active.userId, now: () => new Date(),
      privateTasks,
      controller: { ...active.session.controller, sync: () => active.sync({ force: true }) },
      readPreferences: async () => {
        await active.record(); const settings = personalSnapshot?.settings;
        if (!settings) throw new Error('本人の予定設定を読み込んでいます。しばらくしてから再試行してください。');
        const restDays = settings.restDays.filter((day): day is Weekday => Number.isInteger(day) && day >= 1 && day <= 7);
        if (restDays.length !== settings.restDays.length) throw new Error('本人の休日設定を確認してください。');
        return { ownerUserId: active.userId, settings: { frequencyMode: settings.frequencyMode, restDays,
          loadLimits: { heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit } } };
      } });
  }, [active, context.userId, personalDatabase, refreshPersonal, personalSnapshot]);
  if (!context.ready || !active || active.userId !== context.userId) return <Page><Card><Text style={typography.body}>共有グループを選択してください。</Text>
    <AppButton title="共有グループへ" onPress={() => router.replace('/sharing')} /></Card></Page>;
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const focus = text(params.anchorDate); const anchorContext = focus ? { anchorDate: focus } : {};
  const record = context.groups.find((record) => record.groupId === active.groupId);
  return <V2GroupScreen key={`${active.userId}:${active.groupId}:${active.identity.deviceId}`} purpose="workspace" view={view} loadSession={loadSession} subscribe={subscribe}
    workspaceName={record?.displayName} workspaceError={record?.lastErrorCode ? sharingFailureMessage({ code: record.lastErrorCode }) : undefined}
    anchorDate={focus} choreId={text(params.choreId)} occurrenceId={text(params.occurrenceId)} subjectId={text(params.subjectId)}
    onManage={() => router.push({ pathname: '/sharing', params: { groupId: active.groupId } })}
    onBack={() => view !== 'home' && router.canGoBack() ? router.back() : router.replace('/sharing')}
    onRound={(occurrenceId, subjectId, anchorDate) => router.push({ pathname: '/group-v2/round', params: { occurrenceId, subjectId, ...(anchorDate ? { anchorDate } : anchorContext) } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/date', params: { occurrenceId, subjectId, ...anchorContext } })}
    onAssignment={(occurrenceId, subjectId) => router.push({ pathname: '/group-v2/assignment', params: { occurrenceId, subjectId, ...anchorContext } })}
    onConfiguration={(choreId) => router.push({ pathname: '/group-v2/configuration', params: { choreId } })}
    onDetails={(choreId) => router.push({ pathname: '/group-v2/details', params: { choreId } })}
    onChoreCreated={(choreId) => router.replace({ pathname: '/group-v2/details', params: { choreId } })}
    onManageChores={() => router.push('/group-v2/chores')} onAddChore={() => router.push('/group-v2/add-chore')}
    onGroupPolicy={() => router.push('/group-v2/group-rules')}
    onCalendar={() => router.push('/group-v2/calendar')} onHistory={() => router.push('/group-v2/history')}
    onRequests={() => router.push('/group-v2/requests')} onAssignmentRequests={() => router.push('/group-v2/assignment-requests')} />;
}
