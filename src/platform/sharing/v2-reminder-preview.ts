import { randomUUID } from 'expo-crypto';
import { loadOrCreateSharingDeviceIdentity } from './secure-store';
import { openSharingV2Database } from './database-location';
import { createSharedRoster } from '../../features/sharing/roster';
import { createV2EventRepository, initializeV2EventStore } from '../storage/sharing-v2-events';
import { drainSharingLedger } from '../storage/sharing-ledger';
import { V2_SCHEDULER_VERSION } from '../../features/sharing/v2/payload-schema';
import { v2GroupBootstrap } from '../../features/sharing/v2/bootstrap';
import { chorePolicyFromPreset } from '../../features/sharing/v2/model';
import { createV2GroupController } from '../../features/sharing/v2/controller';
import { createV2ScreenSession } from '../../features/sharing/v2-ui/screen-session';
import { createV2ReminderStore } from '../storage/sharing-v2-reminders';
import { createV2ReminderRuntime } from '../../features/sharing/v2/reminder-runtime';
import { expoLocalNotificationGateway } from '../notifications/expo-local-notification-gateway';
import { v2NotificationPrefix } from '../../features/sharing/v2/native-identity';
import { sharedDocumentDigest } from '../../features/sharing/crypto';
import { sharedLocalDate } from '../../features/sharing/group-clock';

/** Persistent, local synthetic fixture. No Firebase registry, OAuth, Google, real group or personal DB. */
export async function createV2ReminderPreview() {
  if (!__DEV__) throw new Error('通知の検査は開発ビルド専用です。');
  const userId = `qa-reminders-owner-20261029.${V2_SCHEDULER_VERSION}`; const groupId = `qa-reminders-group-20261029.${V2_SCHEDULER_VERSION}`;
  const identity = await loadOrCreateSharingDeviceIdentity(userId, 'development-reminders-20261029');
  if (!__DEV__) throw new Error('通知の検査は開発ビルド専用です。');
  const database = await openSharingV2Database(userId, groupId, 'development-reminders-20261029'); let closed = false;
  const guard = () => { if (!__DEV__ || closed) throw new Error('通知の検査用領域を閉じています。'); };
  const close = async () => { if (closed) return; closed = true; await drainSharingLedger(database); await database.closeAsync(); };
  try {
    guard(); const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 });
    await initializeV2EventStore(database, { userId, groupId, householdId: 'qa-v2-reminders' });
    const repository = createV2EventRepository(database, { userId, groupId, householdId: 'qa-v2-reminders', identity,
      anchor: roster, archive: () => [roster], assertWritable: guard, now: () => new Date() });
    const state = await repository.readState();
    if (!state.replica.operations.length) await repository.commit(v2GroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: '通知検査用',
      name: '開発用・通知検査', timeZone: 'Asia/Tokyo', anchorDate: sharedLocalDate(new Date(), 'Asia/Tokyo'), kind: 'family' }));
    const controller = createV2GroupController(repository, { makeId: randomUUID, now: () => new Date(), sync: async () => { throw new Error('通知検査はクラウドへ送信しません。'); } });
    const today = sharedLocalDate(new Date(), 'Asia/Tokyo'); const choreId = 'qa-reminder-chore';
    const initial = await controller.actions.readPlan({ from: today, through: today, asOfDate: today });
    if (!initial.chores.some(chore => chore.id === choreId)) await repository.commit([
      { operationId: 'qa-reminder-chore-v1', entityType: 'chore', entityId: choreId, operationType: 'patch', payload: { name: '通知検査用の合成家事', enabled: false, load: 'light' } },
    ]);
    if (!(await repository.readState()).assessment.view.topic('chorePolicy', choreId).length) await controller.actions.configureChore(choreId, {
      policy: chorePolicyFromPreset('common'), anchorDate: today, intervalDays: 1, windowBeforeDays: 0, windowAfterDays: 0, effectiveFrom: today, active: true });
    const ui = createV2ScreenSession({ controller, userId, groupId, now: () => new Date(), readPreferences: () => ({ ownerUserId: userId,
      settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 1, normalDailyLimit: 2 } } }) });
    const store = createV2ReminderStore(database, { userId, groupId, assertAccess: guard });
    const runtime = createV2ReminderRuntime({ userId, groupId, store, gateway: expoLocalNotificationGateway, assertAccess: guard,
      readModel: () => ui.readModel({ reminders: true }) });
    const prefix = v2NotificationPrefix(userId, groupId);
    const otherHash = async () => sharedDocumentDigest((await expoLocalNotificationGateway.getScheduledRequests()).filter(row => !row.key.startsWith(prefix))
      .map(row => [row.key, row.title, row.body, row.fireAt, row.data]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))));
    async function verifyOther<T>(work: () => Promise<T>) {
      guard(); const before = await otherHash(); const value = await work(); guard();
      if (await otherHash() !== before) throw new Error('別の通知が更新されました。安定後に再検査してください。'); return value;
    }
    async function todayReference() {
      const model = await ui.readModel({ reminders: true }); guard();
      const date = sharedLocalDate(new Date(), model.plan.timeZone); const round = model.plan.occurrences.find(row => row.choreId === choreId && row.anchorDate === date);
      if (!round) throw new Error('検査する当日の家事回を確認してください。');
      return { model, round, date, ref: { choreId, anchorDate: round.anchorDate, ruleVersion: round.ruleVersion, subjectUserId: null } };
    }
    return { runtime, close,
      async inspect() {
        return verifyOther(async () => {
          const saved = await store.read(); if (!saved.preferences.enabled || saved.preferences.hour !== 19 || saved.preferences.minute !== 17) throw new Error('検査時刻を19時17分・通知ONに設定してください。');
          await runtime.synchronize(); const all = await expoLocalNotificationGateway.getScheduledRequests();
          const count = all.filter(row => row.key.startsWith(prefix)).length;
          if (!count || expoLocalNotificationGateway.maximumScheduledRequests !== undefined && all.length > expoLocalNotificationGateway.maximumScheduledRequests) throw new Error('通知の予約・上限を確認できません。');
          return `通知予約検査 PASS：${count}件・他領域保持`;
        });
      },
      async complete() {
        return verifyOther(async () => {
          const value = await todayReference(); await controller.actions.complete(value.ref); await runtime.synchronize();
          const all = await expoLocalNotificationGateway.getScheduledRequests(); if (all.some(row => row.key === `${prefix}${value.date}`)) throw new Error('完了した当日の通知が残っています。');
          return '通知完了検査 PASS：当日分取消・他領域保持';
        });
      },
      async undo() {
        return verifyOther(async () => {
          const value = await todayReference(); await controller.actions.undoMany(value.round.subjects.flatMap(row => row.completionOperationIds)); await runtime.synchronize();
          const all = await expoLocalNotificationGateway.getScheduledRequests(); if (!all.some(row => row.key === `${prefix}${value.date}`)) throw new Error('取消後の当日の通知を確認できません。');
          return '通知取消検査 PASS：当日分復元・他領域保持';
        });
      },
      async verifySaved() {
        guard(); const saved = await store.read();
        if (saved.preferences.hour !== 19 || saved.preferences.minute !== 17) throw new Error('通知の保護対象設定が一致しません。');
        return `通知保存検査 PASS：19時17分・${saved.preferences.enabled ? 'ON' : 'OFF'}・保存版${saved.revision}`;
      },
      async clean() {
        return verifyOther(async () => { const before = await store.read(); await store.save(before.revision, { ...before.preferences, enabled: false }); await runtime.clear();
          if ((await expoLocalNotificationGateway.getScheduledRequests()).some(row => row.key.startsWith(prefix))) throw new Error('検査通知を取り消せませんでした。');
          return '通知片付け検査 PASS：検査通知0件・他領域保持'; });
      },
    };
  } catch (error) { await close().catch(() => undefined); throw error; }
}
