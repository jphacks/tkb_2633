import type { PrivateCalendarAuthorityIntentPort } from './private-calendar-authority-intents.ts';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../../features/sharing/crypto.ts';
import { sharedDocumentDigest, validateDeviceSecretIdentity } from '../../features/sharing/crypto.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from '../../features/sharing/private-calendar/pairing.ts';
import { createPrivateCalendarPairingRequest, snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from '../../features/sharing/private-calendar/pairing.ts';
import type { ProtectedPrivateCalendarDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import { exactRecord, hexBytes } from '../../features/sharing/private-calendar/validation.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';

interface PairingCandidate { schemaVersion: 1; request: PrivateCalendarPairingRequest; status: 'prepared' | 'approved' }
export interface PrivateCalendarPairingStorePort extends PrivateCalendarAuthorityIntentPort {
  crypto: SharingCryptoGateway;
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
}
/** The out-of-band pin is protected alongside the identity; mutable SQL/Cloud must not choose it on restart. */
export function createPrivateCalendarPairingStorage(port: PrivateCalendarPairingStorePort) {
  const { ownerUserId, crypto, vault, exclusive, assertOwner, readProtected } = port; assertSharedIdentifier(ownerUserId);
  const key = `private-calendar-pairing:${ownerUserId}`;
  function decode(raw: string, state: ProtectedPrivateCalendarDeviceState): PairingCandidate {
    if (raw.length > 16_000) throw new Error('保存した本人端末の確認依頼が大きすぎます。');
    const value = JSON.parse(raw) as PairingCandidate; exactRecord(value, ['schemaVersion', 'request', 'status']);
    if (value.schemaVersion !== 1 || !['prepared', 'approved'].includes(value.status)) throw new Error('保存した本人端末の確認依頼を確認してください。');
    const request = verifyPrivateCalendarPairingRequest(value.request);
    if (request.body.ownerUserId !== ownerUserId || canonicalJson(request.body.device) !== canonicalJson(state.identity)
      || state.authority && (state.authority.anchor.rootDigest !== request.body.rootDigest || state.authority.anchor.accountGeneration !== request.body.accountGeneration)
      || value.status === 'approved' && !state.authority) throw new Error('本人が確認した端末・信頼pinが異なります。');
    return { schemaVersion: 1, request, status: value.status };
  }
  async function locked<T>(work: (raw: string | null, state: ProtectedPrivateCalendarDeviceState | null) => Promise<T>): Promise<T> {
    await assertOwner(ownerUserId);
    const result = await exclusive(ownerUserId, async () => {
      await assertOwner(ownerUserId); const raw = await vault.getItem(key); await assertOwner(ownerUserId);
      const state = raw ? await readProtected() : null; await assertOwner(ownerUserId);
      const value = await work(raw, state); await assertOwner(ownerUserId); return value;
    });
    await assertOwner(ownerUserId); return result;
  }
  return {
    read() { return locked(async (raw, state) => raw ? decode(raw, state!) : null); },
    async prepare(reference: PrivateCalendarPairingReference, identity: DeviceSecretIdentity) {
      const owned = snapshotPrivateCalendarPairingReference(reference); identity = validateDeviceSecretIdentity(identity);
      return locked(async (raw, existingState) => {
        const state = existingState ?? await readProtected(); await assertOwner(ownerUserId);
        if (owned.anchor.ownerUserId !== ownerUserId || identity.deviceId !== state.identity.deviceId
          || state.authority && (state.authority.anchor.rootDigest !== owned.anchor.rootDigest || state.authority.anchor.accountGeneration !== owned.anchor.accountGeneration
            || state.authority.signed.body.devices.some(device => device.deviceId === state.identity.deviceId))) throw new Error('未承認の本人端末と確認した接続先が必要です。');
        if (raw) {
          const saved = decode(raw, state);
          if (saved.request.body.rootDigest !== owned.anchor.rootDigest || saved.request.body.accountGeneration !== owned.anchor.accountGeneration) throw new Error('確認済みの信頼pinを自動で置き換えません。復旧を確認してください。');
          if (saved.request.body.authorityDigest === owned.authorityDigest && saved.request.body.authorityRevision === owned.authorityRevision) return saved;
        }
        const request = await createPrivateCalendarPairingRequest(crypto, owned, identity); const value: PairingCandidate = { schemaVersion: 1, request, status: 'prepared' };
        // Only the public request for an older revision is renewed. No identity/key or formal pin is replaced.
        await vault.setItem(key, canonicalJson(value)); return decode(canonicalJson(value), state);
      });
    },
    markApproved(requestDigest: string) {
      hexBytes(requestDigest, 32);
      return locked(async (raw, state) => {
        if (!raw) return false; const saved = decode(raw, state!); const authority = state!.authority;
        if (sharedDocumentDigest(saved.request) !== requestDigest || !authority || !authority.signed.body.devices.some(device => device.deviceId === state!.identity.deviceId)) return false;
        if (saved.status !== 'approved') await vault.setItem(key, canonicalJson({ ...saved, status: 'approved' })); return true;
      });
    },
  };
}
