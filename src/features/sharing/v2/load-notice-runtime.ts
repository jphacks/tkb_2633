import type { V2DailyLoadAssessment } from './daily-load';
import { v2DailyLoadMessage } from './daily-load.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { v2NativeWorkspaceNamespace } from './native-identity.ts';
import type { V2LoadNoticeStore } from '../../../platform/storage/sharing-v2-load-notices';
import type { V2ReminderControl } from '../../../platform/storage/sharing-v2-reminders';
import { sharedLocalDate } from '../group-clock.ts';
import type { LocalDate } from '../../../domain/shared/types';

export const v2LoadNoticePrefix = (userId: string, groupId: string) => `liflow-v2-load:${v2NativeWorkspaceNamespace(userId, groupId)}:`;
export interface V2LoadNotice { key: string; title: string; body: string; count: number; date: LocalDate }
export function createV2LoadNoticeRuntime(input: { userId: string; groupId: string; store: V2LoadNoticeStore;
  assertAccess(): void | Promise<void>; hasPermission(): Promise<boolean>;
  readControl(): Promise<V2ReminderControl>;
  readCurrent(): Promise<{ assessment?: V2DailyLoadAssessment; control: V2ReminderControl }>;
  present(notice: V2LoadNotice, assertCurrent: () => Promise<void>, beforePresent: () => Promise<boolean>): Promise<void>;
  budgetNow?: () => number; now?: () => Date;
}) {
  const clock = input.budgetNow ?? Date.now;
  let running: Promise<void> | null = null; let deadline = 0;
  const guard = async () => { if (clock() >= deadline) throw new Error('負荷通知は次回の同期で確認します。'); await input.assertAccess(); if (clock() >= deadline) throw new Error('負荷通知は次回の同期で確認します。'); };
  async function execute(assessment: V2DailyLoadAssessment | undefined, control: V2ReminderControl) {
    await guard(); if (!control.preferences.enabled || !assessment) return;
    if (assessment.userId !== input.userId || assessment.groupId !== input.groupId) throw new Error('負荷通知の本人・グループを確認してください。');
    const body = v2DailyLoadMessage(assessment); if (!body) return;
    // The first scope is always the group's civil day, even while its owner's private cache is unavailable.
    const day = assessment.scopes[0]?.date;
    if (!day || await input.store.seen(day)) return;
    await guard(); if (!await input.hasPermission()) return; await guard();
    const assertCurrent = async () => {
      await guard(); const current = await input.readControl(); await guard();
      if (!current.preferences.enabled || current.revision !== control.revision || current.groupRevision !== control.groupRevision
        || assessment.scopes.some(scope => sharedLocalDate((input.now ?? (() => new Date()))(), scope.timeZone) !== scope.date)
        || !await input.hasPermission()) throw new Error('負荷・通知設定が変わりました。次回の同期で確認します。');
      await guard();
    };
    await assertCurrent();
    await input.present({ key: v2LoadNoticePrefix(input.userId, input.groupId) + sharedDocumentDigest(day), date: day,
      title: '今日の家事の負荷が上限に達しています', body, count: assessment.scopes.filter(scope => scope.reached.length).length },
    assertCurrent, async () => {
      // Full private planning is revalidated once, immediately before reservation; queue guards stay cheap.
      await guard(); const current = await input.readCurrent(); await guard();
      if (current.assessment?.revision !== assessment.revision || !current.control.preferences.enabled || current.control.revision !== control.revision
        || current.control.groupRevision !== control.groupRevision) throw new Error('通知前に本人の負荷が変わりました。');
      return input.store.claim(day, assessment.revision, control, guard);
    });
    await guard();
  }
  return { synchronize(assessment: V2DailyLoadAssessment | undefined, control: V2ReminderControl, budgetMs = 10_000) {
    if (!Number.isFinite(budgetMs) || budgetMs < 1 || budgetMs > 60_000) return Promise.reject(new Error('負荷通知の時間枠を確認してください。'));
    if (running) { deadline = Math.min(deadline, clock() + budgetMs); return running; }
    const captured = assessment ? { ...assessment, limits: { ...assessment.limits }, scopes: assessment.scopes.map(scope => ({ ...scope,
      load: { ...scope.load }, reached: [...scope.reached], exceeded: [...scope.exceeded] })) } : undefined;
    const capturedControl = { ...control, preferences: { ...control.preferences } };
    deadline = clock() + budgetMs; const pending = execute(captured, capturedControl); running = pending;
    void pending.finally(() => { if (running === pending) running = null; }).catch(() => {}); return pending;
  } };
}
