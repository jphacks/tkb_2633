import { CalendarPermissionRequiredError, GOOGLE_CALENDAR_FREEBUSY_SCOPE } from './calendar-availability';

export interface CalendarAuthorizationPort {
  grantedScopes(): Promise<readonly string[]>;
  requestScopes(scopes: string[]): Promise<{ accessToken?: string | null }>;
}

/** Only called from an explicit foreground ON/retry action. */
export async function authorizeCalendarAvailability(port: CalendarAuthorizationPort): Promise<void> {
  if ((await port.grantedScopes()).includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) return;
  const response = await port.requestScopes([GOOGLE_CALENDAR_FREEBUSY_SCOPE]);
  if (!response.accessToken || !(await port.grantedScopes()).includes(GOOGLE_CALENDAR_FREEBUSY_SCOPE)) {
    throw new CalendarPermissionRequiredError();
  }
}
