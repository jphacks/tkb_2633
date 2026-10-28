import type { SQLiteDatabase } from 'expo-sqlite';
import type { DeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { sharedDocumentDigest, validateDevicePublicIdentity, validateDeviceSecretIdentity, verifySharedDocument } from '../../features/sharing/crypto.ts';
import type { ProtectedPrivateCalendarDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import type { SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority, PrivateCalendarAuthorityChange } from '../../features/sharing/private-calendar/authority.ts';
import { advancePrivateCalendarAuthority, snapshotPrivateCalendarAuthority, snapshotPrivateCalendarAuthorityChange } from '../../features/sharing/private-calendar/authority.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { hexBytes } from '../../features/sharing/private-calendar/validation.ts';

export interface PrivateCalendarAuthorityIntent { digest: string; rootDigest: string; signed: SignedPrivateCalendarAuthority; current: VerifiedPrivateCalendarAuthority }
export interface PrivateCalendarAuthorityIntentPort {
  ownerUserId: string;
  exclusive<T>(userId: string, work: (db: SQLiteDatabase) => Promise<T>): Promise<T>;
  assertOwner(userId: string): void | Promise<void>;
  readProtected(): Promise<ProtectedPrivateCalendarDeviceState>;
}
interface Row { intent_digest: string; root_digest: string; authority_json: string; status: string }
const TABLE = `CREATE TABLE IF NOT EXISTS private_calendar_authority_intents (
  intent_digest TEXT PRIMARY KEY NOT NULL, root_digest TEXT NOT NULL, authority_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'accepted', 'dismissed'))
);
CREATE UNIQUE INDEX IF NOT EXISTS private_calendar_one_pending_authority ON private_calendar_authority_intents (status) WHERE status = 'pending'`;

/** Public, signed device changes only; no formal authority update before the server receipt. */
export function createPrivateCalendarAuthorityIntentStorage(port: PrivateCalendarAuthorityIntentPort) {
  const { ownerUserId, exclusive, assertOwner, readProtected } = port; assertSharedIdentifier(ownerUserId);
  function decode(row: Row, state: ProtectedPrivateCalendarDeviceState): PrivateCalendarAuthorityIntent {
    if (!state.authority || typeof row.authority_json !== 'string' || row.authority_json.length > 16_000 || !['pending', 'accepted', 'dismissed'].includes(row.status)) throw new Error('保存した本人端末の変更を確認できません。');
    hexBytes(row.intent_digest, 32); hexBytes(row.root_digest, 32);
    const signed = snapshotPrivateCalendarAuthority(JSON.parse(row.authority_json)); const body = signed.body;
    if (sharedDocumentDigest(signed) !== row.intent_digest || row.root_digest !== state.authority.anchor.rootDigest
      || body.accountGeneration !== state.authority.anchor.accountGeneration || body.ownerUserId !== ownerUserId || body.revision < 2
      || body.signerDeviceId !== state.identity.deviceId) throw new Error('準備済みの本人端末の変更が異なります。');
    verifySharedDocument(body, signed.signature, state.identity);
    return { digest: row.intent_digest, rootDigest: row.root_digest, signed, current: state.authority };
  }
  async function locked<T>(work: (db: SQLiteDatabase, state: ProtectedPrivateCalendarDeviceState) => Promise<T>): Promise<T> {
    await assertOwner(ownerUserId);
    const result = await exclusive(ownerUserId, async db => {
      await assertOwner(ownerUserId); const state = await readProtected(); await assertOwner(ownerUserId);
      await db.execAsync(TABLE); const value = await work(db, state); await assertOwner(ownerUserId); return value;
    });
    await assertOwner(ownerUserId); return result;
  }
  const pending = (db: SQLiteDatabase) => db.getFirstAsync<Row>("SELECT * FROM private_calendar_authority_intents WHERE status = 'pending'");
  return {
    readPending() { return locked(async (db, state) => { const row = await pending(db); return row ? decode(row, state) : null; }); },
    async prepare(change: PrivateCalendarAuthorityChange, identity: DeviceSecretIdentity) {
      identity = validateDeviceSecretIdentity(identity); const owned = snapshotPrivateCalendarAuthorityChange(change);
      return locked(async (db, state) => {
        const current = state.authority;
        if (!current || canonicalJson(validateDevicePublicIdentity(identity)) !== canonicalJson(state.identity)) throw new Error('承認済みの本人端末が必要です。');
        const next = advancePrivateCalendarAuthority(current, owned, identity); const row = await pending(db);
        if (row) {
          const saved = decode(row, state);
          if (saved.digest !== next.digest) throw new Error('未送信の本人端末の変更があります。元の変更を確認してください。');
          return saved;
        }
        if (next.digest === current.digest) return null;
        const count = await db.getFirstAsync<{ n: number }>('SELECT COUNT(*) AS n FROM private_calendar_authority_intents');
        if (count && count.n >= 4096) throw new Error('本人端末の変更履歴の保存上限です。既存の内容を保持して復旧を確認してください。');
        const json = canonicalJson(next.signed); if (json.length > 16_000) throw new Error('本人端末の変更が大きすぎます。');
        await db.runAsync("INSERT INTO private_calendar_authority_intents (intent_digest, root_digest, authority_json, status) VALUES (?, ?, ?, 'pending')", next.digest, next.anchor.rootDigest, json);
        return decode({ intent_digest: next.digest, root_digest: next.anchor.rootDigest, authority_json: json, status: 'pending' }, state);
      });
    },
    /** The controller supplies the verified history head after checking this exact intent's server receipt. */
    markAccepted(digest: string, acceptedThrough: VerifiedPrivateCalendarAuthority) {
      hexBytes(digest, 32); const acceptedDigest = acceptedThrough.digest; hexBytes(acceptedDigest, 32);
      return locked(async (db, state) => {
        const row = await db.getFirstAsync<Row>('SELECT * FROM private_calendar_authority_intents WHERE intent_digest = ?', digest); if (!row) return false;
        const saved = decode(row, state);
        if (row.status === 'dismissed' || saved.current.digest !== acceptedDigest || saved.current.signed.body.revision < saved.signed.body.revision) return false;
        await db.runAsync("UPDATE private_calendar_authority_intents SET status = 'accepted' WHERE intent_digest = ?", digest); return true;
      });
    },
    dismissReviewed(digest: string, observedCurrentDigest: string) {
      hexBytes(digest, 32); hexBytes(observedCurrentDigest, 32);
      return locked(async (db, state) => {
        const row = await pending(db); if (!row || row.intent_digest !== digest) return false;
        const saved = decode(row, state);
        if (saved.current.digest !== observedCurrentDigest || saved.current.signed.body.revision < saved.signed.body.revision || saved.current.digest === digest) return false;
        await db.runAsync("UPDATE private_calendar_authority_intents SET status = 'dismissed' WHERE intent_digest = ? AND status = 'pending'", digest); return true;
      });
    },
  };
}
