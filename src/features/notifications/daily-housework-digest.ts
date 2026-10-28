import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry, HouseholdPlannerSettings } from '@/domain/chores/types';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import { addDays, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { LocalNotificationGateway, LocalNotificationRequest } from '@/features/notifications/contracts';
import { sharedDateAtTime, sharedLocalDate } from '../sharing/group-clock';
import { reconcileLocalNotifications } from './reconcile-local-notifications';

const DAILY_DIGEST_KEY_PREFIX = 'housework-digest:';
const SCHEDULE_HORIZON_DAYS = 30;

export interface DailyDigestSnapshot {
  timeZone?: string;
  notificationScope?: string;
  notificationTitle?: string;
  scheduleEntries: readonly ChoreScheduleEntry[];
  chores: readonly (Pick<ChoreDefinition, 'id' | 'name'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[];
  completions: readonly ChoreCompletion[];
  settings: Pick<HouseholdPlannerSettings, 'notificationHour' | 'notificationMinute' | 'notificationsEnabled' | 'setupCompleted'>;
}

export function createDailyHouseworkDigestRequests(
  snapshot: DailyDigestSnapshot,
  now = new Date(),
): LocalNotificationRequest[] {
  const today = snapshot.timeZone ? sharedLocalDate(now, snapshot.timeZone) : localDateFromDate(now);
  const prefix = notificationPrefix(snapshot);
  const requests: LocalNotificationRequest[] = [];

  for (let offset = 0; offset <= SCHEDULE_HORIZON_DAYS; offset += 1) {
    const date = addDays(today, offset);
    const fireAt = snapshot.timeZone ? sharedDateAtTime(date, snapshot.settings.notificationHour, snapshot.settings.notificationMinute, snapshot.timeZone)
      : localDateAtTime(date, snapshot.settings.notificationHour, snapshot.settings.notificationMinute);
    if (fireAt <= now) continue;

    const dueEntries = selectDateTasks(snapshot.scheduleEntries.filter((entry) => isNotificationDay(entry, date)), snapshot.completions, date, 1, snapshot.chores)
      .filter((task) => !task.completed)
      .sort((left, right) => urgency(left.entry!.status) - urgency(right.entry!.status)
        || left.suggestedDate.localeCompare(right.suggestedDate));
    const names = dueEntries
      .map((entry) => snapshot.chores.find((chore) => chore.id === entry.choreId)?.name)
      .filter((name): name is string => Boolean(name));
    if (names.length === 0) continue;

    const visibleNames = names.slice(0, 4).join('、');
    const remaining = names.length - Math.min(names.length, 4);
    requests.push({
      key: `${prefix}${date}`,
      title: snapshot.notificationTitle ?? '今日の家事',
      subtitle: `${names.length}件の未完了タスク`,
      body: `${visibleNames}${remaining > 0 ? `、ほか${remaining}件` : ''}`,
      fireAt: fireAt.toISOString() as LocalNotificationRequest['fireAt'],
      data: { kind: 'daily-housework-digest', date, ...(snapshot.notificationScope ? { workspace: snapshot.notificationScope } : {}) },
    });
  }

  return requests;
}

export async function syncDailyHouseworkDigest(
  gateway: LocalNotificationGateway,
  snapshot: DailyDigestSnapshot,
  now?: Date,
): Promise<void> {
  const enabled = snapshot.settings.notificationsEnabled && snapshot.settings.setupCompleted;
  await reconcileLocalNotifications(gateway, { prefix: notificationPrefix(snapshot), enabled,
    desired: enabled ? createDailyHouseworkDigestRequests(snapshot, now ?? new Date()) : [] });
}

function notificationPrefix(snapshot: DailyDigestSnapshot): string {
  if (!snapshot.notificationScope) return DAILY_DIGEST_KEY_PREFIX;
  if (!/^[a-f0-9]{64}$/u.test(snapshot.notificationScope)) throw new Error('Invalid notification workspace');
  return `liflow-group-digest:${snapshot.notificationScope}:`;
}

function isNotificationDay(entry: ChoreScheduleEntry, date: LocalDate): boolean {
  return date === entry.windowStart
    || date === entry.windowEnd
    || date === addDays(entry.windowEnd, 1);
}

function localDateAtTime(date: LocalDate, hour: number, minute: number): Date {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}

function urgency(status: ChoreScheduleEntry['status']): number {
  if (status === 'overdue') return 0;
  if (status === 'inWindow') return 1;
  if (status === 'initialPending') return 2;
  return 3;
}
