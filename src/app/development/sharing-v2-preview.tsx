import { router, useLocalSearchParams } from 'expo-router';
import { V2DevelopmentPreviewScreen } from '@/features/sharing/development/v2-preview-screen';
import { developmentV2Preview } from '@/platform/sharing/development-v2-preview';

export default function SharingV2PreviewRoute() {
  const params = useLocalSearchParams<{ view?: string; choreId?: string; occurrenceId?: string; subjectId?: string }>();
  return <V2DevelopmentPreviewScreen development={__DEV__} loadSession={developmentV2Preview}
    view={params.view === 'configuration' || params.view === 'history' || params.view === 'round' || params.view === 'date' ? params.view : 'home'} choreId={params.choreId}
    occurrenceId={params.occurrenceId} subjectId={params.subjectId}
    onRound={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview', params: { view: 'round', occurrenceId, subjectId } })}
    onDate={(occurrenceId, subjectId) => router.push({ pathname: '/development/sharing-v2-preview', params: { view: 'date', occurrenceId, subjectId } })}
    onBack={() => router.back()} onConfiguration={(choreId) => router.push({ pathname: '/development/sharing-v2-preview', params: { view: 'configuration', choreId } })}
    onHistory={() => router.push({ pathname: '/development/sharing-v2-preview', params: { view: 'history' } })} />;
}
