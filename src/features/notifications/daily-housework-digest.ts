import type { ChoreCompletion, ChoreDefinition, ChoreScheduleEntry, HouseholdPlannerSettings } from '@/domain/chores/types';
import { selectDateTasks } from '@/domain/scheduling/date-tasks';
import { addDays, localDateFromDate } from '@/domain/scheduling/local-date';
import type { LocalDate } from '@/domain/shared/types';
import type { LocalNotificationGateway, LocalNotificationRequest } from '@/features/notifications/contracts';

const DAILY_DIGEST_KEY_PREFIX = 'housework-digest:';
const SCHEDULE_HORIZON_DAYS = 30;

export interface DailyDigestSnapshot {
  scheduleEntries: readonly ChoreScheduleEntry[];
  chores: readonly (Pick<ChoreDefinition, 'id' | 'name'> & Partial<Pick<ChoreDefinition, 'enabled' | 'archived'>>)[];
  completions: readonly ChoreCompletion[];
  settings: Pick<HouseholdPlannerSettings, 'notificationHour' | 'notificationMinute' | 'notificationsEnabled' | 'setupCompleted'>;
}

export function createDailyHouseworkDigestRequests(
  snapshot: DailyDigestSnapshot,
  now = new Date(),
): LocalNotificationRequest[] {
  const today = localDateFromDate(now);
  const requests: LocalNotificationRequest[] = [];

  for (let offset = 0; offset <= SCHEDULE_HORIZON_DAYS; offset += 1) {
    const date = addDays(today, offset);
    const fireAt = localDateAtTime(date, snapshot.settings.notificationHour, snapshot.settings.notificationMinute);
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
      key: `${DAILY_DIGEST_KEY_PREFIX}${date}`,
      title: '今日の家事',
      subtitle: `${names.length}件の未完了タスク`,
      body: `${visibleNames}${remaining > 0 ? `、ほか${remaining}件` : ''}`,
      fireAt: fireAt.toISOString() as LocalNotificationRequest['fireAt'],
      data: { kind: 'daily-housework-digest', date },
    });
  }

  return requests;
}

export async function syncDailyHouseworkDigest(
  gateway: LocalNotificationGateway,
  snapshot: DailyDigestSnapshot,
  now?: Date,
): Promise<void> {
  const queue = syncQueues.get(gateway) ?? Promise.resolve();
  const operation = queue.then(
    () => performSync(gateway, snapshot, now ?? new Date()),
    () => performSync(gateway, snapshot, now ?? new Date()),
  );
  const tail = operation.then(() => undefined, () => undefined);
  syncQueues.set(gateway, tail);
  void tail.then(() => {
    if (syncQueues.get(gateway) === tail) syncQueues.delete(gateway);
  });
  await operation;
}

const syncQueues = new WeakMap<LocalNotificationGateway, Promise<void>>();

async function performSync(
  gateway: LocalNotificationGateway,
  snapshot: DailyDigestSnapshot,
  now: Date,
): Promise<void> {
  const existing = await gateway.getScheduledRequests();
  const enabled = snapshot.settings.notificationsEnabled && snapshot.settings.setupCompleted && await gateway.hasPermission();
  const requests = enabled ? createDailyHouseworkDigestRequests(snapshot, now) : [];
  const desiredKeys = new Set(requests.map((request) => request.key));
  const existingByKey = new Map(existing.map((request) => [request.key, request]));
  for (const request of requests) {
    const previous = existingByKey.get(request.key);
    if (!previous || requestSignature(previous) !== requestSignature(request)) {
      await gateway.schedule(request);
    }
  }
  for (const request of existing) {
    if (request.key.startsWith(DAILY_DIGEST_KEY_PREFIX) && !desiredKeys.has(request.key)) {
      await gateway.cancel(request.key);
    }
  }
}

function requestSignature(request: LocalNotificationRequest): string {
  return JSON.stringify([
    request.title, request.subtitle ?? '', request.body, request.fireAt,
    Object.entries(request.data ?? {}).sort(([left], [right]) => left.localeCompare(right)),
  ]);
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
