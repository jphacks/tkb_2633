import { useCallback } from 'react';
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

/** Only an explicitly selected, authenticated v2 workspace reaches these controls. */
export function V2WorkspaceRoute({ view }: { view: V2GroupScreenProps['view'] }) {
  const context = useWorkspace(); const personal = usePlannerData(); const router = useRouter();
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string }>();
  const active = context.active?.protocol === 2 ? context.active : null;
  const subscribe = useCallback((changed: () => void) => subscribeSharingChanges((scope) => {
    if (active && scope?.userId === active.userId && scope.groupId === active.groupId) changed();
  }), [active]);
  const loadSession = useCallback(async () => {
    if (!active || context.userId !== active.userId) throw new Error('共有グループを選択してください。');
    await active.record();
    return createV2ScreenSession({ groupId: active.groupId, userId: active.userId, now: () => new Date(),
      controller: { ...active.session.controller, sync: () => active.sync({ force: true }) },
      readPreferences: async () => {
        await active.record(); const settings = personal.snapshot?.settings;
        if (!settings) throw new Error('本人の予定設定を読み込んでいます。しばらくしてから再試行してください。');
        const restDays = settings.restDays.filter((day): day is Weekday => Number.isInteger(day) && day >= 1 && day <= 7);
        if (restDays.length !== settings.restDays.length) throw new Error('本人の休日設定を確認してください。');
        return { ownerUserId: active.userId, settings: { frequencyMode: settings.frequencyMode, restDays,
          loadLimits: { heavyDailyLimit: settings.heavyDailyLimit, normalDailyLimit: settings.normalDailyLimit } } };
      } });
  }, [active, context.userId, personal.snapshot]);
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
    onCalendar={() => router.push('/group-v2/calendar')} onHistory={() => router.push('/group-v2/history')}
    onRequests={() => router.push('/group-v2/requests')} onAssignmentRequests={() => router.push('/group-v2/assignment-requests')} />;
}
