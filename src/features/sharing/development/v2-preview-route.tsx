import { useLocalSearchParams, useRouter } from 'expo-router';
import { V2DevelopmentPreviewScreen } from './v2-preview-screen';
import { developmentV2Preview } from '@/platform/sharing/development-v2-preview';
import { useCallback } from 'react';
import type { V2GroupScreenProps } from '../v2-ui/group-screen';

export type V2PreviewView = V2GroupScreenProps['view'];

/** Separate Native stack screens retain their own inputs, scroll position and route parameters. */
export function V2PreviewRoute({ view }: { view: V2PreviewView }) {
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string; anchorDate?: string; personal?: string }>();
  const router = useRouter();
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  const focus = text(params.anchorDate); const personal = text(params.personal) === '1'; const privateContext = personal ? { personal: '1' } : {};
  const context = { ...privateContext, ...(focus ? { anchorDate: focus } : {}) };
  const loadSession = useCallback(() => developmentV2Preview(personal), [personal]);
  return <V2DevelopmentPreviewScreen key={personal ? 'private-fixture' : 'shared-fixture'} development={__DEV__} loadSession={loadSession} view={view}
    anchorDate={focus}
    choreId={text(params.choreId)} occurrenceId={text(params.occurrenceId)} subjectId={text(params.subjectId)}
    onRound={(occurrenceId, subjectId, anchorDate) => router.push({ pathname: '/development/sharing-v2-preview/round', params: { occurrenceId, subjectId, ...context, ...(anchorDate ? { anchorDate } : {}) } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview/date', params: { occurrenceId, subjectId, ...context } })}
    onAssignment={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview/assignment', params: { occurrenceId, subjectId, ...context } })}
    onBack={() => router.back()}
    onConfiguration={(choreId) => router.push({ pathname: '/development/sharing-v2-preview/configuration', params: { choreId, ...privateContext } })}
    onDetails={(choreId) => router.push({ pathname: '/development/sharing-v2-preview/details', params: { choreId, ...privateContext } })}
    onChoreCreated={(choreId) => router.replace({ pathname: '/development/sharing-v2-preview/details', params: { choreId, ...privateContext } })}
    onManageChores={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/chores', params: privateContext } : '/development/sharing-v2-preview/chores')}
    onAddChore={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/add-chore', params: privateContext } : '/development/sharing-v2-preview/add-chore')}
    onGroupPolicy={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/group-rules', params: privateContext } : '/development/sharing-v2-preview/group-rules')}
    onWaste={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/waste', params: privateContext } : '/development/sharing-v2-preview/waste')}
    onDateRights={(choreId) => router.push({ pathname: '/development/sharing-v2-preview/date-rights', params: { choreId, ...privateContext } })}
    onHistory={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/history', params: privateContext } : '/development/sharing-v2-preview/history')}
    onCalendar={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/calendar', params: privateContext } : '/development/sharing-v2-preview/calendar')}
    onAssignmentRequests={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/assignment-requests', params: privateContext } : '/development/sharing-v2-preview/assignment-requests')}
    onRequests={() => router.push(personal ? { pathname: '/development/sharing-v2-preview/requests', params: privateContext } : '/development/sharing-v2-preview/requests')} />;
}
