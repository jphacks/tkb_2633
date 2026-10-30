export const PRIVATE_CALENDAR_AUTOMATIC_BUDGET_MS = 25_000;
export const PRIVATE_CALENDAR_MANUAL_BUDGET_MS = 100_000;
export const PRIVATE_CALENDAR_REFRESH_MS = 10 * 60_000;
export function privateCalendarDeadlineError() {
  return Object.assign(new Error('本人用Calendarの同期時間を超えました。保存済みの内容を保持して再試行します。'), { code: 'deadline-exceeded' });
}
export function privateCalendarDeadline(now: number, budgetMs: number) {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(budgetMs) || budgetMs < 1 || budgetMs > 110_000
    || !Number.isSafeInteger(now + budgetMs)) throw new Error('本人用Calendarの同期時間を確認してください。');
  return now + budgetMs;
}
export function assertPrivateCalendarDeadline(deadline: number | undefined, now: number) {
  if (deadline !== undefined && (!Number.isSafeInteger(deadline) || !Number.isSafeInteger(now) || now >= deadline)) throw privateCalendarDeadlineError();
}
/** Firestore cannot cancel an already queued immutable write. Bound the caller and fence later work separately. */
export function withinPrivateCalendarDeadline<T>(work: Promise<T>, milliseconds: number, onTimeout?: () => void): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { onTimeout?.(); reject(privateCalendarDeadlineError()); }, milliseconds);
    work.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}
