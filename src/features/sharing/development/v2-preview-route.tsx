import { useLocalSearchParams, useRouter } from 'expo-router';
import { V2DevelopmentPreviewScreen } from './v2-preview-screen';
import { developmentV2Preview } from '@/platform/sharing/development-v2-preview';

export type V2PreviewView = 'home' | 'configuration' | 'history' | 'round' | 'date' | 'requests' | 'assignment' | 'assignmentRequests';

/** Separate Native stack screens retain their own inputs, scroll position and route parameters. */
export function V2PreviewRoute({ view }: { view: V2PreviewView }) {
  const params = useLocalSearchParams<{ choreId?: string; occurrenceId?: string; subjectId?: string }>();
  const router = useRouter();
  const text = (value: unknown) => typeof value === 'string' ? value : undefined;
  return <V2DevelopmentPreviewScreen development={__DEV__} loadSession={developmentV2Preview} view={view}
    choreId={text(params.choreId)} occurrenceId={text(params.occurrenceId)} subjectId={text(params.subjectId)}
    onRound={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview/round', params: { occurrenceId, subjectId } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview/date', params: { occurrenceId, subjectId } })}
    onAssignment={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview/assignment', params: { occurrenceId, subjectId } })}
    onBack={() => router.back()}
    onConfiguration={(choreId) => router.push({ pathname: '/development/sharing-v2-preview/configuration', params: { choreId } })}
    onHistory={() => router.push('/development/sharing-v2-preview/history')}
    onAssignmentRequests={() => router.push('/development/sharing-v2-preview/assignment-requests')}
    onRequests={() => router.push('/development/sharing-v2-preview/requests')} />;
}
