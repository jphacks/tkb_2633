import type { LocalDate } from '../../../domain/shared/types';
import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { ScheduleSettings } from '../../../domain/scheduling/contracts';
import { sharedLocalDate } from '../group-clock.ts';
import type { V2GroupController, V2GroupScreenModel } from '../v2/controller';
import { buildV2PersonalPlan } from '../v2/personal-plan.ts';
import type { V2PersonalPlan } from '../v2/personal-plan';
import { v2CalendarMonth } from './calendar-projection.ts';
import type { V2PrivateOverlayState, V2PrivateTaskSource } from './private-overlay';

export interface V2GroupUiSession {
  controller: V2GroupController; groupId: string; userId: string;
  privateTasks?: V2PrivateTaskSource;
  readModel: (options?: { calendarMonth?: string; focusDate?: string; detailChoreId?: string; management?: boolean; groupPolicy?: boolean; permissionsChoreId?: string }) => Promise<V2GroupScreenModel & { personal?: V2PersonalPlan; privateOverlay?: V2PrivateOverlayState }>;
}

/** The UI computes its range and personal suggestions from one authenticated group clock. */
export function createV2ScreenSession(input: { controller: V2GroupController; groupId: string; userId: string; now: () => Date;
  readPreferences: () => { ownerUserId: string; settings: ScheduleSettings } | Promise<{ ownerUserId: string; settings: ScheduleSettings }>;
  privateTasks?: V2PrivateTaskSource;
}): V2GroupUiSession {
  return { controller: input.controller, groupId: input.groupId, userId: input.userId, privateTasks: input.privateTasks,
    async readModel(options) {
      if (options?.calendarMonth && options.focusDate) throw new Error('月表示と家事回の表示を同時に指定できません。');
      if (options?.management && (options.calendarMonth || options.focusDate)) throw new Error('編集画面と月・家事回の表示を同時に指定できません。');
      const instant = input.now(); const preferences = options?.management ? null : await input.readPreferences();
      if (preferences && preferences.ownerUserId !== input.userId) throw new Error('本人の予定設定を確認してください。');
      const model = await input.controller.readModel(({ timeZone }) => {
        const date = sharedLocalDate(instant, timeZone); const focus = options?.focusDate as LocalDate | undefined;
        if (options?.management) return { from: date, through: date, asOfDate: date };
        if (focus) parseLocalDate(focus);
        const calendar = options?.calendarMonth ? v2CalendarMonth(options.calendarMonth === 'current' ? date : options.calendarMonth as LocalDate) : null;
        return { from: addDays(calendar?.from ?? focus ?? date, -14), through: addDays(calendar?.through ?? focus ?? date, 14), asOfDate: date };
      }, { detailChoreId: options?.detailChoreId, groupPolicy: options?.groupPolicy, permissionsChoreId: options?.permissionsChoreId });
      if (model.viewerUserId !== input.userId || model.plan.groupId !== input.groupId) throw new Error('表示する共有アカウント・グループが変わりました。');
      if (!preferences) return model;
      let privateOverlay: V2PrivateOverlayState | undefined;
      if (input.privateTasks && !options?.management) try {
        privateOverlay = await input.privateTasks.read(model.plan.range, instant);
        if (privateOverlay.ownerUserId !== input.userId) throw new Error('本人の個人家事を確認してください。');
      } catch { privateOverlay = { status: 'unavailable', message: '個人家事を取得できませんでした。個人モードの状態を確認し、再読込してください。' }; }
      const privateLoad = privateOverlay?.status === 'ready' && privateOverlay.timeZone === model.plan.timeZone
        ? { ownerUserId: input.userId, days: privateOverlay.dailyLoad } : undefined;
      const personal = buildV2PersonalPlan(model.plan, { viewerUserId: input.userId, now: instant.getTime(), settings: preferences.settings, privateLoad });
      return { ...model, personal, ...(privateOverlay ? { privateOverlay } : {}) };
    } };
}
