import type { V2GroupScreenModel } from './controller';
import type { V2CommonPlan } from './common-plan';
import { v2CanShowCompletion } from '../v2-ui/round-visibility.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { v2NativeWorkspaceNamespace } from './native-identity.ts';

export function v2CompletionNoticePrefix(userId: string, groupId: string) {
  return `liflow-v2-completed:${v2NativeWorkspaceNamespace(userId, groupId)}:`;
}
/** Normalize concurrent completions to the same subject/round. No personal task or Calendar input is accepted. */
export function v2CompletionNoticeCandidates(plan: V2CommonPlan, userId: string, adminUserId: string) {
  if (!plan.initialized || !plan.members.some(member => member.userId === userId && member.active)) throw new Error('完了通知の共有グループを確認してください。');
  const model = { plan, viewerUserId: userId, adminUserId } as V2GroupScreenModel;
  const names = new Map(plan.chores.map(chore => [chore.id, chore.name]));
  const bySubject = new Map<string, { key: string; name: string; notify: boolean }>();
  for (const record of plan.history) {
    if (!record.active || record.outcome !== 'completed' || record.acceptance !== 'accepted' || !record.performedTimeConfirmed) continue;
    const key = sharedDocumentDigest(['v2-completion-notice', plan.groupId, record.subjectOccurrenceId]);
    const notify = record.recorderUserId !== userId && v2CanShowCompletion(model, record);
    const previous = bySubject.get(key);
    bySubject.set(key, { key, name: names.get(record.choreId) ?? '共有家事', notify: notify || previous?.notify === true });
  }
  return [...bySubject.values()].sort((a, b) => a.key.localeCompare(b.key));
}
