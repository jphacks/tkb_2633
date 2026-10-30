import { useLocalSearchParams } from 'expo-router';
import { V2PreviewRoute } from '@/features/sharing/development/v2-preview-route';

/** Keep old development deep links readable; new navigation uses a distinct route per screen. */
export default function SharingV2PreviewIndex() {
  const { view } = useLocalSearchParams<{ view?: string }>();
  return <V2PreviewRoute view={view === 'configuration' || view === 'history' || view === 'round' || view === 'date' || view === 'requests' ? view : 'home'} />;
}
