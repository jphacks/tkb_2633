import type { SQLiteDatabase } from 'expo-sqlite';
import { createDeviceIdentity } from '../crypto.ts';
import type { SharingCryptoGateway } from '../crypto.ts';
import { createSharedRoster } from '../roster.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { initializeV2EventStore, createV2EventRepository } from '../../../platform/storage/sharing-v2-events.ts';
import { v2GroupBootstrap } from '../v2/bootstrap.ts';
import { createV2GroupController } from '../v2/controller.ts';
import { chorePolicyFromPreset } from '../v2/model.ts';
import { buildV2PersonalPlan } from '../v2/personal-plan.ts';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { v2CalendarMonth } from '../v2-ui/calendar-projection.ts';

/** Local development fixture only. No registry, login, cloud, personal data or fabricated server receipts. */
export async function createV2DevelopmentPreview(input: {
  development: boolean; crypto: SharingCryptoGateway; makeId: () => string; now: () => Date;
  openDatabase: (userId: string, groupId: string) => Promise<{ database: SQLiteDatabase; close: () => Promise<void> }>;
}) {
  if (!input.development) throw new Error('Development preview is unavailable');
  const token = input.makeId(); const groupId = `qa-v2-${token}`; const userId = `qa-v2-owner-${token}`; const householdId = 'qa-v2-isolated';
  const identity = await createDeviceIdentity(input.crypto); const roster = createSharedRoster(groupId, userId, identity, { schemaVersion: 2 });
  const opened = await input.openDatabase(userId, groupId); const database = opened.database;
  try {
    await initializeV2EventStore(database, { groupId, userId, householdId });
    const repository = createV2EventRepository(database, { groupId, userId, householdId, identity, anchor: roster, archive: () => [roster], now: input.now,
      assertWritable: () => { if (!input.development) throw new Error('Development preview is unavailable'); } });
    const controller = createV2GroupController(repository, { makeId: input.makeId, now: input.now,
      sync: async () => { throw new Error('このプレビューは端末内の検査専用です。クラウドへ送信しません。'); } });
    const today = sharedLocalDate(input.now(), 'Asia/Tokyo');
    await repository.commit(v2GroupBootstrap({ groupId, ownerUserId: userId, ownerDisplayName: '検査ユーザー', name: '開発用・端末内プレビュー',
      timeZone: 'Asia/Tokyo', anchorDate: today, kind: 'family' }));
    const plan = await controller.actions.readPlan({ from: today, through: today, asOfDate: today });
    for (const [name, preset, anchorDate, intervalDays] of [
      ['フローリングを掃除する', 'common', today, 7], ['部屋のほこりを取る', 'eachMember', today, 7], ['浴室全体を掃除する', 'common', addDays(today, -7), 30],
    ] as const) {
      const chore = plan.chores.find((entry) => entry.name === name); if (!chore) throw new Error('開発用の家事を準備できませんでした。');
      await controller.actions.configureChore(chore.id, { policy: chorePolicyFromPreset(preset), anchorDate, intervalDays,
        windowBeforeDays: 2, windowAfterDays: 2, effectiveFrom: anchorDate, active: true });
    }
    return { controller, groupId, userId, close: opened.close,
      readModel: async (options?: { calendarMonth?: string; focusDate?: string }) => {
        if (options?.calendarMonth && options.focusDate) throw new Error('月表示と家事回の表示を同時に指定できません。');
        const instant = input.now();
        const model = await controller.readModel(({ timeZone }) => {
          const date = sharedLocalDate(instant, timeZone); const focus = options?.focusDate as LocalDate | undefined;
          if (focus) parseLocalDate(focus);
          const calendar = options?.calendarMonth ? v2CalendarMonth(options.calendarMonth === 'current' ? date : options.calendarMonth as LocalDate) : null;
          return { from: addDays(calendar?.from ?? focus ?? date, -14), through: addDays(calendar?.through ?? focus ?? date, 14), asOfDate: date };
        });
        // Explicit synthetic preferences, never the logged-in user's private settings or Calendar.
        const personal = buildV2PersonalPlan(model.plan, { viewerUserId: userId, now: instant.getTime(),
          settings: { frequencyMode: 'balanced', restDays: [], loadLimits: { heavyDailyLimit: 2, normalDailyLimit: 3 } } });
        return { ...model, personal }; },
    };
  } catch (error) { await opened.close().catch(() => undefined); throw error; }
}
export type V2DevelopmentPreview = Awaited<ReturnType<typeof createV2DevelopmentPreview>>;
export type V2DevelopmentPreviewModel = Awaited<ReturnType<V2DevelopmentPreview['readModel']>>;
