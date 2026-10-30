import { useLocalSearchParams } from 'expo-router';
import { usePlannerData } from '@/hooks/use-planner-data';
import { PlannerHistoryContent } from '@/features/planner/history-content';

export default function HistoryScreen() {
  const params = useLocalSearchParams<{ choreId?: string; source?: string }>();
  const choreId = Array.isArray(params.choreId) ? params.choreId[0] : params.choreId;
  const data = usePlannerData({ personal: params.source === 'personal' });
  return <PlannerHistoryContent data={data} requestedChoreId={choreId} />;
}
