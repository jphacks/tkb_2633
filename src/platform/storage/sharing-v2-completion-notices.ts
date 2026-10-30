import type { SQLiteDatabase } from 'expo-sqlite';
import type { createV2EventRepository } from './sharing-v2-events';
import { buildV2CommonPlan } from '../../features/sharing/v2/common-plan.ts';
import { v2ReadPoint } from '../../features/sharing/v2/view-point.ts';
import { sharedLocalDate } from '../../features/sharing/group-clock.ts';
import { v2CompletionNoticeCandidates } from '../../features/sharing/v2/completion-notices.ts';
import type { GroupPolicy } from '../../features/sharing/v2/model';

type Repository = ReturnType<typeof createV2EventRepository>;
type State = Awaited<ReturnType<Repository['readState']>>;
export interface V2CompletionNoticeBatch { revision: string; keys: string[]; names: string[] }
/** Durable at-most-once claims: a crash after claiming may omit a notice, but cannot replay old work on every launch. */
export function createV2CompletionNoticeStore(input: { repository: Repository; userId: string; groupId: string; assertAccess(): void | Promise<void> }) {
  const { repository, userId, groupId } = input;
  if (repository.scope.userId !== userId || repository.scope.groupId !== groupId) throw new Error('完了通知の保存先を確認してください。');
  const enabled = (state: State) => {
    const at = v2ReadPoint(state.assessment.view, state.archive.at(-1)!);
    try { return (state.assessment.view.field('groupPolicy', 'policy', 'configuration', at)?.value as unknown as GroupPolicy)?.completionPushEnabled === true; }
    catch { return false; }
  };
  async function initialize(transaction: SQLiteDatabase) {
    await input.assertAccess();
    const row = await transaction.getFirstAsync<{ user_id: string; group_id: string; schema_version: number }>('SELECT user_id,group_id,schema_version FROM sharing_v2_binding WHERE singleton=1');
    if (row?.user_id !== userId || row.group_id !== groupId || row.schema_version !== 2) throw new Error('完了通知の保存先が変わりました。');
    await transaction.execAsync(`CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1), was_enabled INTEGER NOT NULL CHECK(was_enabled IN (0,1)));
      CREATE TABLE IF NOT EXISTS sharing_v2_private_notice_seen(subject_key TEXT PRIMARY KEY, claimed INTEGER NOT NULL CHECK(claimed IN (0,1)));`);
    await input.assertAccess();
  }
  async function paused(transaction: SQLiteDatabase) {
    await transaction.runAsync('INSERT INTO sharing_v2_private_notice_state VALUES(1,0) ON CONFLICT(singleton) DO UPDATE SET was_enabled=0 WHERE was_enabled!=0');
    await input.assertAccess();
  }
  return {
    scope: Object.freeze({ userId, groupId }),
    enabled: () => repository.readCurrent(async (state, transaction) => {
      await initialize(transaction); const allowed = enabled(state); if (!allowed) await paused(transaction); return allowed;
    }),
    collect(permitted: boolean, now: Date, assertCurrent: () => void | Promise<void> = input.assertAccess): Promise<V2CompletionNoticeBatch | null> {
      const instant = new Date(now); if (typeof permitted !== 'boolean' || !Number.isFinite(instant.getTime())) return Promise.reject(new Error('完了通知の時刻と許可を確認してください。'));
      return repository.readCurrent(async (state, transaction) => {
        await initialize(transaction);
        if (!permitted || !enabled(state)) { await paused(transaction); return null; }
        const roster = state.archive.at(-1)!; const at = v2ReadPoint(state.assessment.view, roster);
        const zone = state.assessment.view.field('settings', 'settings', 'timeZone', at)?.value;
        if (typeof zone !== 'string') throw new Error('完了通知の地域を確認してください。');
        const today = sharedLocalDate(instant, zone); const plan = buildV2CommonPlan(state, { from: today, through: today, asOfDate: today });
        const candidates = v2CompletionNoticeCandidates(plan, userId, roster.body.ownerUserId);
        const prior = await transaction.getFirstAsync<{ was_enabled: number }>('SELECT was_enabled FROM sharing_v2_private_notice_state WHERE singleton=1');
        if (prior && ![0, 1].includes(prior.was_enabled)) throw new Error('完了通知の確認状態を読み直してください。');
        const seen = await transaction.getAllAsync<{ subject_key: string; claimed: number }>('SELECT subject_key,claimed FROM sharing_v2_private_notice_seen');
        if (seen.some(row => !/^[a-f0-9]{64}$/u.test(row.subject_key) || ![0, 1].includes(row.claimed))) throw new Error('完了通知の確認記録を読み直してください。');
        const known = new Set(seen.map(row => row.subject_key)); const fresh = candidates.filter(row => !known.has(row.key));
        const notify = (row: typeof fresh[number]) => prior?.was_enabled === 1 && row.notify;
        for (let offset = 0; offset < fresh.length; offset += 100) {
          await input.assertAccess(); await assertCurrent(); const page = fresh.slice(offset, offset + 100);
          await transaction.runAsync(`INSERT INTO sharing_v2_private_notice_seen VALUES ${page.map(() => '(?,?)').join(',')}`, ...page.flatMap(row => [row.key, notify(row) ? 1 : 0]));
        }
        const notices = fresh.filter(notify); const keys = notices.map(row => row.key); const names = notices.map(row => row.name);
        await transaction.runAsync('INSERT INTO sharing_v2_private_notice_state VALUES(1,1) ON CONFLICT(singleton) DO UPDATE SET was_enabled=1');
        const projection = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
        await input.assertAccess(); if (!keys.length) return null;
        if (!projection || !/^[a-f0-9]{64}$/u.test(projection.fact_hash)) throw new Error('完了通知の共有状態を確認してください。');
        return { revision: projection.fact_hash, keys, names };
      });
    },
    current: (batch: V2CompletionNoticeBatch) => repository.readCurrent(async (state, transaction) => {
      await initialize(transaction); const projection = await transaction.getFirstAsync<{ fact_hash: string }>('SELECT fact_hash FROM sharing_v2_projection WHERE singleton=1');
      return enabled(state) && projection?.fact_hash === batch.revision;
    }),
  };
}
export type V2CompletionNoticeStore = ReturnType<typeof createV2CompletionNoticeStore>;
