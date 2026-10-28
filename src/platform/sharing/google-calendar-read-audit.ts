import { createGoogleCalendarReadAudit } from '../../features/sharing/development/google-calendar-read-audit';
import { getDeviceTimeZone } from '../../features/google-sync/calendar-availability';
import { withGoogleSyncOperation } from '../../features/google-sync/operation-lock';
import { createCalendarFreeBusyClient } from '../google-tasks/google-calendar-freebusy-client';
import { authorizePrivateGoogleCalendarSource, getCurrentGoogleCalendarAccount, getGoogleCalendarAccessToken, getCurrentGoogleSubject, restorePrivateGoogleCalendarAccount } from '../google-tasks/google-sign-in-gateway';
import { GoogleAccountMismatchError } from '../../features/google-sync/account-binding';

/** Uses existing Native Google auth and the real read API; no Firebase, SQLite, key, or Cloud publication. */
export function openGoogleCalendarReadAudit() {
  if (!__DEV__) throw new Error('Google読取検査は開発ビルド専用です。');
  return createGoogleCalendarReadAudit({ development: () => __DEV__, now: Date.now, timeZone: getDeviceTimeZone,
    currentAccount: () => withGoogleSyncOperation(getCurrentGoogleCalendarAccount),
    restoreAccount: () => withGoogleSyncOperation(restorePrivateGoogleCalendarAccount),
    authorize: subject => withGoogleSyncOperation(() => authorizePrivateGoogleCalendarSource(subject)),
    query: (subject, range) => withGoogleSyncOperation(async () => {
      const token = await getGoogleCalendarAccessToken(subject); let requests = 0;
      const client = createCalendarFreeBusyClient(fetch, () => { requests++; }); const intervals = await client.query(token, range);
      if (await getCurrentGoogleSubject() !== subject) throw new GoogleAccountMismatchError(); return { intervals, requests };
    }) });
}
