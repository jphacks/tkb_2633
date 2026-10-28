import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { sharedDocumentDigest, validateDeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import type { VerifiedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import type { ProtectedPrivateCalendarDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import type { PrivateCalendarCryptoGateway } from '../../features/sharing/private-calendar/crypto-gateway.ts';
import { verifyPrivateCalendarWrappedKey, wrapPrivateCalendarKey } from '../../features/sharing/private-calendar/key-envelope.ts';
import type { WrappedPrivateCalendarKey } from '../../features/sharing/private-calendar/key-envelope.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { hexBytes } from '../../features/sharing/private-calendar/validation.ts';
import { assertPrivateCalendarDeliveryFailure, privateCalendarDeliveryRetry } from '../../features/sharing/private-calendar/delivery-retry.ts';
import type { PrivateCalendarDeliveryFailure } from '../../features/sharing/private-calendar/delivery-retry.ts';

interface Row { authority_digest: string; recipient_id: string; envelope_digest: string; envelope_json: string; pending: number; attempts: number; retry_at: number | null; failure_code: string | null }
export interface PrivateCalendarKeyOutboxEntry { authorityDigest: string; recipientDeviceId: string; envelopeDigest: string; wrapped: WrappedPrivateCalendarKey; pending: boolean; attempts: number; retryAt: number | null }
export interface PrivateCalendarKeyOutboxPort {
  ownerUserId: string; crypto: PrivateCalendarCryptoGateway;
  exclusive<T>(userId: string, work: (db: SQLiteDatabase) => Promise<T>): Promise<T>;
  assertOwner(userId: string): void | Promise<void>;
  readProtected(): Promise<ProtectedPrivateCalendarDeviceState>;
}
const TABLE = `CREATE TABLE IF NOT EXISTS private_calendar_key_outbox (
  authority_digest TEXT NOT NULL, recipient_id TEXT NOT NULL, envelope_digest TEXT NOT NULL, envelope_json TEXT NOT NULL,
  pending INTEGER NOT NULL CHECK (pending IN (0, 1)), attempts INTEGER NOT NULL CHECK (attempts >= 0), retry_at INTEGER, failure_code TEXT,
  PRIMARY KEY (authority_digest, recipient_id)
)`;

/** Keeps the exact signed ciphertext across retries; only obsolete transport copies are retired. */
export function createPrivateCalendarKeyOutbox(port: PrivateCalendarKeyOutboxPort) {
  const { ownerUserId, crypto, exclusive, assertOwner, readProtected } = port; assertSharedIdentifier(ownerUserId);
  function decode(row: Row, authority: VerifiedPrivateCalendarAuthority): PrivateCalendarKeyOutboxEntry {
    if (typeof row.envelope_json !== 'string' || row.envelope_json.length > 8_000 || row.authority_digest !== authority.digest
      || ![0, 1].includes(row.pending) || !Number.isSafeInteger(row.attempts) || row.attempts < 0
      || row.retry_at !== null && (!Number.isSafeInteger(row.retry_at) || row.retry_at < 0)) throw new Error('保存した本人用の配布鍵を確認できません。');
    hexBytes(row.envelope_digest, 32); if (row.failure_code !== null) assertPrivateCalendarDeliveryFailure(row.failure_code as PrivateCalendarDeliveryFailure);
    const wrapped = verifyPrivateCalendarWrappedKey(JSON.parse(row.envelope_json), authority, row.recipient_id);
    if (sharedDocumentDigest(wrapped) !== row.envelope_digest) throw new Error('準備済みの配布鍵の内容が異なります。');
    return { authorityDigest: row.authority_digest, recipientDeviceId: row.recipient_id, envelopeDigest: row.envelope_digest, wrapped,
      pending: row.pending === 1, attempts: row.attempts, retryAt: row.retry_at };
  }
  async function locked<T>(expectedDigest: string, work: (db: SQLiteDatabase, state: ProtectedPrivateCalendarDeviceState) => Promise<T>): Promise<T> {
    hexBytes(expectedDigest, 32); await assertOwner(ownerUserId);
    const result = await exclusive(ownerUserId, async db => {
      await assertOwner(ownerUserId); const state = await readProtected(); await assertOwner(ownerUserId);
      if (!state.authority || state.authority.digest !== expectedDigest || state.authority.signed.body.ownerUserId !== ownerUserId
        || !state.authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId)) throw new Error('本人端末の承認・鍵世代が変わりました。');
      await db.execAsync(TABLE); const value = await work(db, state); await assertOwner(ownerUserId); return value;
    });
    await assertOwner(ownerUserId); return result;
  }
  const record = (db: SQLiteDatabase, digest: string, recipient: string) => db.getFirstAsync<Row>('SELECT * FROM private_calendar_key_outbox WHERE authority_digest = ? AND recipient_id = ?', digest, recipient);
  return {
    status(authority: VerifiedPrivateCalendarAuthority) {
      return locked(authority.digest, async (db, state) => {
        const row = await db.getFirstAsync<{ pending: number | null; retry_at: number | null }>(`SELECT SUM(pending) AS pending,
          MIN(CASE WHEN pending = 1 THEN retry_at ELSE NULL END) AS retry_at FROM private_calendar_key_outbox WHERE authority_digest = ?`, state.authority!.digest);
        const pending = row?.pending ?? 0; const retryAt = row?.retry_at ?? null;
        if (!Number.isSafeInteger(pending) || pending < 0 || pending > 16 || retryAt !== null && (!Number.isSafeInteger(retryAt) || retryAt < 0)) throw new Error('配布鍵の送信状態を確認できません。');
        return { pending, retryAt };
      });
    },
    async prepare(authority: VerifiedPrivateCalendarAuthority, recipient: string, identity: DeviceSecretIdentity, accountKey: Uint8Array) {
      const digest = authority.digest; assertSharedIdentifier(recipient); identity = validateDeviceSecretIdentity(identity);
      if (!(accountKey instanceof Uint8Array) || accountKey.length !== 32) throw new Error('本人用の保存鍵が必要です。');
      const ownedKey = accountKey.slice();
      try {
        return await locked(digest, async (db, state) => {
          const current = state.authority!;
          if (identity.deviceId !== state.identity.deviceId || identity.signingPublicKey !== state.identity.signingPublicKey || identity.agreementPublicKey !== state.identity.agreementPublicKey
            || !state.hasCurrentKey || !current.signed.body.devices.some(device => device.deviceId === recipient)) throw new Error('承認済みの本人端末と保存鍵が必要です。');
          const row = await record(db, digest, recipient); if (row) return decode(row, current);
          const wrapped = await wrapPrivateCalendarKey(crypto, ownedKey, current, identity, recipient);
          const json = canonicalJson(wrapped); if (json.length > 8_000) throw new Error('本人用の配布鍵が大きすぎます。');
          const envelopeDigest = sharedDocumentDigest(wrapped);
          // These old authority-bound envelopes can no longer be sent. Protected keys/history are untouched.
          await db.runAsync('DELETE FROM private_calendar_key_outbox WHERE authority_digest <> ?', digest);
          await db.runAsync('INSERT INTO private_calendar_key_outbox (authority_digest, recipient_id, envelope_digest, envelope_json, pending, attempts, retry_at, failure_code) VALUES (?, ?, ?, ?, 1, 0, NULL, NULL)', digest, recipient, envelopeDigest, json);
          return decode({ authority_digest: digest, recipient_id: recipient, envelope_digest: envelopeDigest, envelope_json: json, pending: 1, attempts: 0, retry_at: null, failure_code: null }, current);
        });
      } finally { ownedKey.fill(0); }
    },
    pending(authority: VerifiedPrivateCalendarAuthority, now: number) {
      if (!Number.isSafeInteger(now) || now < 0) throw new Error('配布鍵の再送時刻を確認してください。');
      return locked(authority.digest, async (db, state) => {
        const rows = await db.getAllAsync<Row>('SELECT * FROM private_calendar_key_outbox WHERE authority_digest = ? ORDER BY recipient_id LIMIT 17', state.authority!.digest);
        if (rows.length > 16) throw new Error('配布する本人端末の件数が多すぎます。');
        return rows.map(row => decode(row, state.authority!)).filter(entry => entry.pending && (entry.retryAt === null || entry.retryAt <= now));
      });
    },
    acknowledge(authority: VerifiedPrivateCalendarAuthority, recipient: string, envelopeDigest: string) {
      const digest = authority.digest; assertSharedIdentifier(recipient); hexBytes(envelopeDigest, 32);
      return locked(digest, async (db, state) => {
        const row = await record(db, digest, recipient); if (!row || decode(row, state.authority!).envelopeDigest !== envelopeDigest) return false;
        await db.runAsync('UPDATE private_calendar_key_outbox SET pending = 0, attempts = 0, retry_at = NULL, failure_code = NULL WHERE authority_digest = ? AND recipient_id = ?', digest, recipient); return true;
      });
    },
    fail(authority: VerifiedPrivateCalendarAuthority, recipient: string, envelopeDigest: string, now: number, code: PrivateCalendarDeliveryFailure, randomFraction: number) {
      const digest = authority.digest; assertSharedIdentifier(recipient); hexBytes(envelopeDigest, 32); assertPrivateCalendarDeliveryFailure(code); privateCalendarDeliveryRetry(0, now, randomFraction);
      return locked(digest, async (db, state) => {
        const row = await record(db, digest, recipient); if (!row || decode(row, state.authority!).envelopeDigest !== envelopeDigest || !row.pending) return false;
        const retry = privateCalendarDeliveryRetry(row.attempts, now, randomFraction);
        await db.runAsync('UPDATE private_calendar_key_outbox SET attempts = ?, retry_at = ?, failure_code = ? WHERE authority_digest = ? AND recipient_id = ?', retry.attempts, retry.retryAt, code, digest, recipient); return true;
      });
    },
  };
}
