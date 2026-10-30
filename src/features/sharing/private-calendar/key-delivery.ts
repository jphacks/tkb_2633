import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarKeyOutbox } from '../../../platform/storage/private-calendar-key-outbox.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import { privateCalendarDeliveryFailureCode } from './delivery-retry.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import { PrivateCalendarCloudConflict } from './cloud-contract.ts';

export function createPrivateCalendarKeyDelivery(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  outbox: ReturnType<typeof createPrivateCalendarKeyOutbox>; cloud: Pick<ReturnType<typeof createPrivateCalendarCloud>, 'sendKey'> & Partial<Pick<ReturnType<typeof createPrivateCalendarCloud>, 'readKey'>>;
  now?: () => number; randomFraction?: () => number }) {
  const { userId, secrets, outbox, cloud, now = Date.now, randomFraction = Math.random } = port; assertSharedIdentifier(userId);
  async function queueApprovedDevices() {
    const authority = await secrets.authority(userId); if (!authority) throw new Error('本人端末の信頼を先に確認してください。');
    const identity = await secrets.identity(userId); const body = authority.signed.body;
    if (!body.devices.some(device => device.deviceId === identity.deviceId)) throw new Error('この本人端末の承認は解除されています。');
    const recipients = body.devices.filter(device => device.deviceId !== identity.deviceId);
    if (!recipients.length) return { kind: 'queued' as const, count: 0 };
    let key = await secrets.currentKey(userId, authority);
    try {
      if (!key) {
        if (authority.keyIssuer?.deviceId !== identity.deviceId) return { kind: 'awaitingKey' as const, count: 0 };
        key = await secrets.createCurrentKey(userId, authority);
      }
      for (const recipient of recipients) await outbox.prepare(authority, recipient.deviceId, identity, key);
      return { kind: 'queued' as const, count: recipients.length };
    } finally { key?.fill(0); }
  }
  async function sendDue(force: boolean) {
    const authority = await secrets.authority(userId); if (!authority) throw new Error('本人端末の信頼を先に確認してください。');
    const entries = await outbox.pending(authority, now(), { force }); let sent = 0; let available = 0;
    for (const entry of entries) {
      try { await cloud.sendKey(authority, entry.wrapped); }
      catch (error) {
        if (error instanceof PrivateCalendarCloudConflict && cloud.readKey) {
          try {
            const accepted = await cloud.readKey(authority, entry.recipientDeviceId);
            if (accepted && await outbox.observeAvailable(authority, entry.recipientDeviceId, entry.envelopeDigest, accepted)) { available++; continue; }
          } catch { /* Invalid signatures, changed owner/authority and same-sender forks never acknowledge a candidate. */ }
        }
        const code = privateCalendarDeliveryFailureCode(error);
        await outbox.fail(authority, entry.recipientDeviceId, entry.envelopeDigest, now(), code, randomFraction());
        return { kind: 'deferred' as const, sent, code };
      }
      if (!await outbox.acknowledge(authority, entry.recipientDeviceId, entry.envelopeDigest)) throw new Error('配布鍵の確認中に本人端末の設定が変わりました。');
      sent++;
    }
    const status = await outbox.status(authority);
    return status.pending ? { kind: 'waiting' as const, sent, pending: status.pending, nextRetryAt: status.retryAt, ...(available ? { available } : {}) }
      : { kind: 'sent' as const, sent, pending: 0, ...(available ? { available } : {}) };
  }
  let flight: ReturnType<typeof sendDue> | null = null;
  const flush = (options: { force?: boolean } = {}): ReturnType<typeof sendDue> => {
    const force = options.force === true;
    if (flight) return flight.then(result => force && result.kind === 'waiting' ? flush({ force: true }) : result);
    if (!flight) {
      const pending = sendDue(force); flight = pending;
      void pending.finally(() => { if (flight === pending) flight = null; }).catch(() => {});
    }
    return flight;
  };
  return { queueApprovedDevices, flush };
}
