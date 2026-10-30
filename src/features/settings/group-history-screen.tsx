import { router, useLocalSearchParams } from 'expo-router';
import { useContext } from 'react';
import { WorkspaceContext } from '@/contexts/workspace-context';
import { PlannerLoadState } from '@/components/planner-load-state';
import { PlannerHistoryContent } from '../planner/history-content';
import { useGroupChoreSettings } from './use-group-chore-settings';

export function GroupHistoryScreen() {
  const context = useContext(WorkspaceContext); const params = useLocalSearchParams<{ groupId: string; choreId?: string }>();
  if (!context?.userId || typeof params.groupId !== 'string' || !context.groups.some(row => row.userId === context.userId
    && row.groupId === params.groupId && ['active', 'creating'].includes(row.status))) return <PlannerLoadState title="実施履歴" message="履歴を読み込んでいます。"
      error="このグループの参加状態を確認してください。" retry={async () => router.back()} />;
  return <GroupHistory key={`${context.userId}:${params.groupId}`} userId={context.userId} groupId={params.groupId}
    choreId={typeof params.choreId === 'string' ? params.choreId : undefined} />;
}
function GroupHistory({ userId, groupId, choreId }: { userId: string; groupId: string; choreId?: string }) {
  const data = useGroupChoreSettings({ userId, groupId }); const value = data.snapshot;
  if (value?.protocol === 1) return <PlannerHistoryContent requestedChoreId={choreId} data={{ snapshot: value.snapshot, loading: false, error: data.error, refresh: data.source.refresh }} />;
  return <PlannerLoadState title="実施履歴" message="履歴を読み込んでいます。" error={value ? 'このグループの履歴を一覧から開き直してください。' : data.error} retry={data.source.refresh} />;
}
