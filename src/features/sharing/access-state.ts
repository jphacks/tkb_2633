import type { VerifiedSharedRoster } from './roster.ts';

/** Only a verified membership change or a server read can prove revocation. */
export function sharedAccessDisposition(input: { errorCode: string; currentAccountUserId: string | null; userId: string;
  deviceId: string; status: string | undefined; roster: VerifiedSharedRoster | undefined }): 'removed' | 'check-membership' | 'retain' {
  if (input.status !== 'active' || input.currentAccountUserId !== input.userId
    || !['permission-denied', 'sharing/access-denied'].includes(input.errorCode)) return 'retain';
  if (input.roster && !input.roster.body.members.some((member) => member.userId === input.userId
    && member.devices.some((device) => device.identity.deviceId === input.deviceId))) return 'removed';
  return input.errorCode === 'permission-denied' ? 'check-membership' : 'retain';
}
