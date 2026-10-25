import type { CalendarQueryRange } from '@/features/google-sync/calendar-availability';

export class CalendarFreeBusyError extends Error {
  readonly status: number;
  readonly code: string;
  readonly retryAfter: string | null;
  constructor(status: number, code: string, retryAfter: string | null = null) {
    super('Calendar availability request failed');
    this.name = 'CalendarFreeBusyError';
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
  }
}

export interface CalendarFreeBusyClient {
  query(accessToken: string, range: CalendarQueryRange): Promise<{ start: string; end: string }[]>;
}

// The live API rejected the planner's 181-day coverage as timeRangeTooLong.
// Split transport requests only; the Scheduler horizon and atomic cache coverage stay intact.
export const FREEBUSY_QUERY_CHUNK_MS = 90 * 24 * 60 * 60 * 1000;

export function createCalendarFreeBusyClient(fetcher: typeof fetch = fetch, onRequest?: () => void): CalendarFreeBusyClient {
  const queryWindow = async (accessToken: string, range: CalendarQueryRange): Promise<{ start: string; end: string }[]> => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    try {
      onRequest?.();
      const response = await fetcher('https://www.googleapis.com/calendar/v3/freeBusy', {
        method: 'POST', signal: controller.signal,
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ timeMin: range.timeMin, timeMax: range.timeMax, timeZone: range.timeZone, items: [{ id: 'primary' }] }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok) {
        const errors = payload?.error?.errors;
        const reasons: string[] = Array.isArray(errors) ? errors.map((item: { reason?: string }) => item?.reason ?? '') : [];
        const message = typeof payload?.error?.message === 'string' ? payload.error.message.toLowerCase() : '';
        const rangeError = /(?:time|date).*(?:range|period).*(?:too long|too large|exceed|maximum)/u.test(message)
          ? 'calendar_time_range_too_long' : /time.*range.*empty/u.test(message) ? 'calendar_time_range_empty'
            : /time.?zone/u.test(message) ? 'calendar_time_zone_invalid'
              : /primary/u.test(message) ? 'calendar_primary_invalid' : undefined;
        const rateLimited = response.status === 403 && reasons.some((reason) => ['userRateLimitExceeded', 'rateLimitExceeded'].includes(reason));
        const permission = response.status === 401 || (response.status === 403 &&
          (reasons.some((reason) => ['insufficientPermissions', 'forbidden'].includes(reason)) || /insufficient.*scopes/u.test(message)));
        const code = reasons.some((reason) => ['accessNotConfigured', 'serviceDisabled'].includes(reason))
          ? 'calendar_api_not_enabled' : rateLimited ? 'calendar_rate_limited'
            : permission ? 'calendar_permission_required' : rangeError ?? `calendar_http_${response.status}`;
        throw new CalendarFreeBusyError(response.status, code, response.headers.get('Retry-After'));
      }
      const calendar = payload?.calendars?.primary;
      if (Array.isArray(calendar?.errors) && calendar.errors.length) {
        const reasons = calendar.errors.map((item: { reason?: string }) => item?.reason);
        if (reasons.includes('internalError')) throw new CalendarFreeBusyError(503, 'calendar_internal_error');
        if (reasons.includes('forbidden')) throw new CalendarFreeBusyError(403, 'calendar_permission_required');
        throw new CalendarFreeBusyError(400, 'calendar_item_error');
      }
      if (!calendar || !Array.isArray(calendar.busy)) throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
      return calendar.busy.map((item: { start?: unknown; end?: unknown }) => {
        if (typeof item?.start !== 'string' || typeof item?.end !== 'string') throw new CalendarFreeBusyError(502, 'calendar_invalid_response');
        return { start: item.start, end: item.end };
      });
    } finally { clearTimeout(timer); }
  };
  return {
    async query(accessToken, range) {
      const min = Date.parse(range.timeMin);
      const max = Date.parse(range.timeMax);
      if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) throw new CalendarFreeBusyError(400, 'calendar_time_range_empty');
      const intervals: { start: string; end: string }[] = [];
      for (let start = min; start < max; start += FREEBUSY_QUERY_CHUNK_MS) {
        intervals.push(...await queryWindow(accessToken, { ...range,
          timeMin: new Date(start).toISOString(), timeMax: new Date(Math.min(max, start + FREEBUSY_QUERY_CHUNK_MS)).toISOString() }));
      }
      return intervals;
    },
  };
}
