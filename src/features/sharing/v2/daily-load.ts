import type { LocalDate } from '../../../domain/shared/types';
import type { V2GroupScreenModel } from './controller';
import type { V2PersonalDayLoad, V2PersonalPlan } from './personal-plan';
import { parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { v2OwnedPendingSchedule } from './owner-schedule.ts';
import { isSharedTimeZone } from '../group-clock.ts';

export interface V2DailyLoadScope {
  source: 'combined' | 'shared' | 'personal'; date: LocalDate; timeZone: string;
  load: V2PersonalDayLoad; untimed: number; reached: ('heavy' | 'normal')[]; exceeded: ('heavy' | 'normal')[];
}
export interface V2DailyLoadAssessment {
  userId: string; groupId: string; planHash: string; revision: string;
  limits: { heavyDailyLimit: number; normalDailyLimit: number }; scopes: V2DailyLoadScope[];
  privateStatus: 'ready' | 'unavailable'; timeConflict: 'excluded'; relocation: 'excluded';
}
interface PrivateDayLoads { status: 'ready'; ownerUserId: string; today: LocalDate; timeZone: string;
  dailyLoad: Readonly<Partial<Record<LocalDate, V2PersonalDayLoad>>>;
  home?: readonly { completed: boolean; chore: { load: 'heavy' | 'normal' | 'light' } }[] }
const empty = (): V2PersonalDayLoad => ({ heavy: 0, normal: 0, total: 0 });
function load(value: V2PersonalDayLoad | undefined): V2PersonalDayLoad {
  if (!value) return empty();
  if (![value.heavy, value.normal, value.total].every(n => Number.isSafeInteger(n) && n >= 0)
    || value.heavy + value.normal > value.total) throw new Error('本人の家事の負荷を確認してください。');
  return { heavy: value.heavy, normal: value.normal, total: value.total };
}
function personalToday(overlay: PrivateDayLoads) {
  if (!overlay.home) return load(overlay.dailyLoad[overlay.today]);
  // The current home selector also includes overdue work in its grace period, exactly once per chore.
  const value = empty();
  for (const row of overlay.home) if (!row.completed) { value.total++; if (row.chore.load !== 'light') value[row.chore.load]++; }
  return value;
}

/** D10: date-only work has no invented start time, Calendar overlap check or relocation command. */
export function assessV2UntimedDailyLoad(input: { model: V2GroupScreenModel; userId: string; personal?: V2PersonalPlan;
  privateOverlay?: PrivateDayLoads | { status: 'unavailable' }; limits: V2DailyLoadAssessment['limits'] }): V2DailyLoadAssessment {
  const { model, userId } = input; const { plan } = model;
  const limits = { heavyDailyLimit: input.limits.heavyDailyLimit, normalDailyLimit: input.limits.normalDailyLimit };
  if (!Number.isSafeInteger(limits.heavyDailyLimit) || limits.heavyDailyLimit < 1 || limits.heavyDailyLimit > 10
    || !Number.isSafeInteger(limits.normalDailyLimit) || limits.normalDailyLimit < 1 || limits.normalDailyLimit > 20) throw new Error('本人の1日の負荷上限を確認してください。');
  parseLocalDate(plan.range.asOfDate);
  const own = v2OwnedPendingSchedule(model, userId, input.personal, 'load').filter(row => row.date === plan.range.asOfDate);
  const shared = empty(); let untimed = 0;
  for (const row of own) { shared.total++; if (row.chore.load !== 'light') shared[row.chore.load]++; if (row.untimed) untimed++; }
  const overlay = input.privateOverlay;
  if (overlay?.status === 'ready' && overlay.ownerUserId !== userId) throw new Error('本人以外の個人家事は集計できません。');
  const scopes: V2DailyLoadScope[] = [];
  const append = (source: V2DailyLoadScope['source'], date: LocalDate, timeZone: string, value: V2PersonalDayLoad, count: number) => {
    parseLocalDate(date); if (!isSharedTimeZone(timeZone)) throw new Error('家事の地域を確認してください。');
    const reached = (['heavy', 'normal'] as const).filter(kind => value[kind] >= limits[kind === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit']);
    scopes.push({ source, date, timeZone, load: value, untimed: count, reached: count ? reached : [],
      exceeded: count ? reached.filter(kind => value[kind] > limits[kind === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit']) : [] });
  };
  if (overlay?.status === 'ready' && overlay.timeZone === plan.timeZone && overlay.today === plan.range.asOfDate) {
    const ownLoad = personalToday(overlay);
    append('combined', plan.range.asOfDate, plan.timeZone,
      { heavy: shared.heavy + ownLoad.heavy, normal: shared.normal + ownLoad.normal, total: shared.total + ownLoad.total }, untimed + ownLoad.total);
  } else {
    append('shared', plan.range.asOfDate, plan.timeZone, shared, untimed);
    if (overlay?.status === 'ready') { const ownLoad = personalToday(overlay); append('personal', overlay.today, overlay.timeZone, ownLoad, ownLoad.total); }
  }
  const body = { userId, groupId: plan.groupId, planHash: plan.planHash, limits, scopes,
    privateStatus: overlay?.status === 'ready' ? 'ready' as const : 'unavailable' as const,
    timeConflict: 'excluded' as const, relocation: 'excluded' as const };
  return { ...body, revision: sharedDocumentDigest(body) };
}

export function v2DailyLoadMessage(assessment: V2DailyLoadAssessment) {
  const scopes = assessment.scopes.filter(scope => scope.reached.length);
  if (!scopes.length) return null;
  return scopes.map(scope => `${scope.date}（${scope.source === 'combined' ? '個人と共有' : scope.source === 'personal' ? '個人' : '共有'}・${scope.timeZone}）：${scope.reached.map(kind =>
    `${kind === 'heavy' ? '重い' : '普通の'}家事${scope.load[kind]}件／上限${assessment.limits[kind === 'heavy' ? 'heavyDailyLimit' : 'normalDailyLimit']}件`).join('、')}`).join('\n');
}
