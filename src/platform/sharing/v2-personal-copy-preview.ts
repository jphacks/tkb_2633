import { randomUUID } from 'expo-crypto';
import { loadOrCreateSharingDeviceIdentity } from './secure-store';
import { openSharingV2Database } from './database-location';
import { createSharedRoster } from '../../features/sharing/roster';
import { createV2EventRepository, initializeV2EventStore } from '../storage/sharing-v2-events';
import { drainSharingLedger } from '../storage/sharing-ledger';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema';
import { v2GroupBootstrap } from '../../features/sharing/v2/bootstrap';
import { sharedLocalDate } from '../../features/sharing/group-clock';
import { createV2PersonalCopyStore } from '../storage/sharing-v2-personal-copy';
import { createV2PersonalCopyRuntime } from '../../features/sharing/v2/personal-copy-runtime';
import type { V2PersonalCopySource } from '../../features/sharing/v2/personal-copy';
import { sharedDocumentDigest } from '../../features/sharing/crypto';
import { buildV2CommonPlan } from '../../features/sharing/v2/common-plan';

/** Real Native identity, v2 SQLite and normal copy UI; source is synthetic and never reads a personal DB or a cloud account. */
export async function createV2PersonalCopyPreview() {
  if (!__DEV__) throw new Error('コピーの検査は開発ビルド専用です。');
  const userId = `qa-copy-owner-20261029.${V2_SCHEDULER_VERSION}`; const groupId = `qa-copy-group-20261029.${V2_SCHEDULER_VERSION}`;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, 'development-v2-copy-20261029');
  if (!__DEV__) throw new Error('コピーの検査は開発ビルド専用です。');
  const database = await openSharingV2Database(userId, groupId, 'development-v2-copy-20261029'); let closed = false;
  const guard = () => { if (!__DEV__ || closed) throw new Error('検査用のコピー画面を閉じています。'); };
  const close = async () => { if (closed) return; closed = true; await drainSharingLedger(database); await database.closeAsync(); };
  try {
    const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 });
    await initializeV2EventStore(database, { userId, groupId, householdId: 'qa-v2-copy' });
    const repository = createV2EventRepository(database, { userId, groupId, householdId: 'qa-v2-copy', identity,
      anchor: roster, archive: () => [roster], assertWritable: guard, now: () => new Date() });
    if (!(await repository.readState()).replica.operations.length) await repository.commit(v2GroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: 'コピー検査用',
      name: '開発用・設定コピー検査', timeZone: 'Asia/Tokyo', anchorDate: sharedLocalDate(new Date(), 'Asia/Tokyo'), kind: 'family' }));
    const source: V2PersonalCopySource = { scope: 'personal', ownerUserId: userId, householdId: 'local-household', frequencyMode: 'balanced', chores: [
      { id: 'synthetic-copy-floor', householdId: 'local-household', name: '合成コピー家事・床', category: '検査', description: '個人データを使わない合成説明', enabled: true,
        frequencyDaysByMode: { frequent: 3, balanced: 7, relaxed: 14 }, windowRadiusDays: 2, maxShiftDays: 2, load: 'normal', holidayPriority: false, everyday: false,
        estimatedMinutes: 20, instructions: ['合成手順1', '合成手順2'], tools: ['合成の道具'], cautions: ['合成の注意'], trivia: [{ id: 'synthetic-trivia', title: '合成の補足', body: '補足の本文も確認できます。' }] },
      { id: 'synthetic-copy-conditional', householdId: 'local-household', name: '合成コピー家事・条件付き', category: '検査', description: '周期を指定しない合成家事', enabled: true,
        requiresCycleSelection: true, manufacturerRecommendedConditions: ['汚れが目立った場合'], frequencyDaysByMode: { frequent: 1, balanced: 1, relaxed: 1 },
        windowRadiusDays: 0, maxShiftDays: 0, load: 'light', holidayPriority: false, everyday: false, instructions: ['状態を確認'], tools: [], cautions: [] },
    ] };
    const sourceHash = sharedDocumentDigest(source); const store = createV2PersonalCopyStore({ repository, userId, groupId, assertAccess: guard, makeId: randomUUID, now: () => new Date() });
    const runtime = createV2PersonalCopyRuntime({ userId, groupId, store, assertAccess: guard, readSource: async ids => {
      guard(); return { ...source, chores: source.chores.filter(chore => !ids || ids.includes(chore.id)) };
    } });
    return { runtime, close, async inspect() {
      guard(); const saved = await store.read(); if (!saved.review || saved.review.records.length !== 2) throw new Error('合成2件を選んで確認してください。');
      const state = await repository.readState(); const copied = saved.review.records.flatMap(record => [record.choreOperationId, ...(record.configuration ? [record.configurationOperationId] : [])]);
      if (sharedDocumentDigest(source) !== sourceHash || state.replica.operations.some(op => op.entityType === 'completion')) throw new Error('合成の元設定・履歴が一致しません。');
      if (saved.status === 'review' && copied.some(id => state.replica.operations.some(op => op.operationId === id))) throw new Error('確認前の追加を検出しました。');
      if (saved.status === 'committed') {
        if (saved.synchronization !== 'pending' || copied.some(id => state.replica.operations.filter(op => op.operationId === id).length !== 1)) throw new Error('追加結果を確認できません。');
        await runtime.confirm(saved.review); const after = await repository.readState();
        if (after.replica.operations.length !== state.replica.operations.length) throw new Error('二重追加を検出しました。');
        const plan = buildV2CommonPlan(after, { from: saved.review.anchorDate, through: saved.review.anchorDate, asOfDate: saved.review.anchorDate });
        if (plan.history.length || plan.occurrences.length !== 1) throw new Error('未来予定・過去履歴を確認できません。');
      }
      return `コピー保存検査 PASS：${saved.status === 'committed' ? '追加済み・二重追加なし' : '確認中・共有追加なし'}・元設定保持・過去履歴0件・照合値${sharedDocumentDigest(saved.review)}`;
    } };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
