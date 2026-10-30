import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import { sharedLocalDate } from '../group-clock.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { createCalendarQueryRange } from '../../google-sync/calendar-availability.ts';
import type { CalendarQueryRange } from '../../google-sync/calendar-availability';
import { snapshotPrivateCalendarIntervals } from '../private-calendar/calendar-capture.ts';

/** Read-only service audit. Never returns tokens, Google identifiers or private time intervals. */
export function createGoogleCalendarReadAudit(port: {
  development(): boolean; now(): number; timeZone(): string;
  currentAccount(): Promise<{ subject: string; label: string } | null>;
  restoreAccount(): Promise<{ subject: string; label: string }>;
  authorize(subject: string): Promise<void>;
  query(subject: string, range: CalendarQueryRange): Promise<{ intervals: readonly { start: string; end: string }[]; requests: number }>;
}) {
  const assertDevelopment = () => { if (!port.development()) throw new Error('Google読取検査は開発ビルド専用です。'); };
  let account: string | null = null;
  let flight: Promise<{ days: number; requests: number; intervals: number }> | null = null;
  async function checkAccount() { assertDevelopment(); const current = await port.currentAccount(); assertDevelopment(); account = current?.subject ?? null; if (account) assertSharedIdentifier(account); return { ready: account !== null }; }
  async function assertSame(subject: string) {
    assertDevelopment(); if (account !== subject || (await port.currentAccount())?.subject !== subject) throw new Error('検査中にGoogleアカウントが変わりました。'); assertDevelopment();
  }
  async function read() {
    const subject = account; if (!subject) throw new Error('Googleログインを確認してください。'); await assertSame(subject);
    const zone = port.timeZone(); const today = sharedLocalDate(new Date(port.now()), zone); const range = createCalendarQueryRange(today, addDays(today, 180), zone);
    const response = await port.query(subject, range); await assertSame(subject);
    if (!Number.isSafeInteger(response.requests) || response.requests < 1 || response.requests > 8) throw new Error('Google取得の通信数を確認できません。');
    const intervals = snapshotPrivateCalendarIntervals(response.intervals, range);
    return { days: daysBetween(range.from, range.through) + 1, requests: response.requests, intervals: intervals.length };
  }
  return {
    checkAccount,
    async restoreAccount() { assertDevelopment(); await port.restoreAccount(); return checkAccount(); },
    async authorize() { assertDevelopment(); const selected = account; if (!selected) throw new Error('Googleログインを確認してください。'); await assertSame(selected); await port.authorize(selected); await assertSame(selected); },
    read() {
      assertDevelopment(); if (flight) return flight;
      const pending = read(); flight = pending; void pending.finally(() => { if (flight === pending) flight = null; }).catch(() => {}); return pending;
    },
  };
}
