import { createPrivateCalendarRootAuditContext } from './private-calendar-root-audit';
import { developmentPrivateCalendarAuthorityIntents, developmentPrivateCalendarSource, developmentPrivateCalendarCache,
  developmentPrivateCalendarKeyOutbox, developmentPrivateCalendarPairing } from './private-calendar-secrets';
import { createPrivateCalendarDeviceSession } from '../../features/sharing/private-calendar/device-session';
import { createPrivateCalendarAuthoritySync } from '../../features/sharing/private-calendar/authority-sync';
import { createPrivateCalendarSourceController } from '../../features/sharing/private-calendar/source-controller';
import { createPrivateCalendarRuntime } from '../../features/sharing/private-calendar/runtime';

/** Actual Native crypto/Keychain/SQLite and Emulator Rules, with a separate synthetic Google source. */
export async function createPrivateCalendarSourcePreview(platform: string, host: unknown, port: unknown) {
  if (!__DEV__) throw new Error('取得元の検査は開発ビルドだけで使用できます。');
  const context = await createPrivateCalendarRootAuditContext(platform, host, port, 'source');
  try {
    const { userId, secrets, cloud } = context; const expected = `development-calendar-native-source-${platform}-v1`;
    if (userId !== expected) throw new Error('取得元の検査専用の保存先が必要です。');
    const assertOwner = () => { if (!__DEV__ || userId !== expected) throw new Error('検査の取得元が変わりました。'); };
    const intents = developmentPrivateCalendarAuthorityIntents(userId); const cache = developmentPrivateCalendarCache(userId); const source = developmentPrivateCalendarSource(userId);
    const authoritySync = createPrivateCalendarAuthoritySync({ userId, secrets, intents, cloud });
    const devices = createPrivateCalendarDeviceSession({ userId, secrets, cloud, roots: context.intents, intents,
      candidates: developmentPrivateCalendarPairing(userId), outbox: developmentPrivateCalendarKeyOutbox(userId), cache, assertOwner });
    const subject = `synthetic-google-source-${platform}`; let queries = 0;
    const runtime = createPrivateCalendarRuntime({ userId, assertOwner, secrets, source, cache, cloud, devices, crypto: context.crypto,
      sourceController: createPrivateCalendarSourceController({ userId, secrets, source, intents, authoritySync }), timeZone: () => 'Asia/Tokyo',
      currentGoogleAccount: async () => ({ subject, label: '検査用Googleアカウント（合成）' }),
      authorizeGoogleSource: async expectedSubject => { assertOwner(); if (expectedSubject !== subject) throw new Error('検査用取得元が異なります。'); },
      queryGoogle: async (expectedSubject, range) => {
        assertOwner(); if (expectedSubject !== subject) throw new Error('検査用取得元が異なります。'); queries++;
        const start = Date.parse(range.timeMin) + 9 * 3600000; return [{ start: new Date(start).toISOString(), end: new Date(start + 3600000).toISOString() }];
      } });
    return { runtime, async initialize() { const view = await devices.read(); return view.phase === 'unconfigured' ? devices.initializeFirstDevice() : view; },
      async verifyAutomatic() {
        if ((await runtime.refreshData()).kind !== 'published') throw new Error('検査用取得元の接続を先に確認してください。');
        const before = queries; const calls = Array.from({ length: 100 }, () => runtime.synchronizeAutomatically());
        if (new Set(calls).size !== 1 || !(await Promise.all(calls)).every(result => result.kind === 'fresh') || queries !== before) throw new Error('自動同期の再取得制限が一致しません。');
        return { requests: calls.length, queries: queries - before };
      },
      async verify() {
        const data = await runtime.readForPlan(); if (!data || data.ownerUserId !== userId || data.cache.intervals.length !== 1) throw new Error('検査用の保存データがありません。');
        const part = data.cache.intervals[0]; const busy = await runtime.readOwnCalendar({ precision: 'interval', ...part }); const end = Date.parse(part.end);
        const free = await runtime.readOwnCalendar({ precision: 'interval', start: new Date(end + 60000).toISOString(), end: new Date(end + 120000).toISOString() });
        if (busy.kind !== 'conflict' || free.kind !== 'clear') throw new Error('本人の日時判定が一致しません。');
        return { revision: (await runtime.readSettings()).device.revision, queries };
      }, close: context.close };
  } catch (error) { await context.close(); throw error; }
}
