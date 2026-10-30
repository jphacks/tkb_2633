export type PrivateCalendarDeliveryFailure = 'offline' | 'temporary' | 'auth' | 'permission' | 'unknown';
/** Persist only a fixed category, never a provider message or account/token content. */
export function privateCalendarDeliveryFailureCode(error: unknown): PrivateCalendarDeliveryFailure {
  const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
  if (code === 'permission-denied') return 'permission'; if (code === 'unauthenticated') return 'auth';
  return ['unavailable', 'aborted', 'deadline-exceeded', 'resource-exhausted'].includes(code) ? 'temporary' : 'unknown';
}
export function privateCalendarDeliveryRetry(previousAttempts: number, now: number, randomFraction: number) {
  if (!Number.isSafeInteger(previousAttempts) || previousAttempts < 0 || !Number.isSafeInteger(now) || now < 0
    || !Number.isFinite(randomFraction) || randomFraction < 0 || randomFraction > 1) throw new Error('再送の条件を確認できません。');
  const attempts = Math.min(previousAttempts + 1, 1_000_000);
  const delay = Math.round(Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.min(attempts - 1, 10) * (0.8 + 0.4 * randomFraction)));
  const retryAt = now + delay; if (!Number.isSafeInteger(retryAt)) throw new Error('再送に使う端末の時刻を確認してください。');
  return { attempts, retryAt };
}
export function assertPrivateCalendarDeliveryFailure(code: PrivateCalendarDeliveryFailure) {
  if (!['offline', 'temporary', 'auth', 'permission', 'unknown'].includes(code)) throw new Error('再送の条件を確認できません。');
}
