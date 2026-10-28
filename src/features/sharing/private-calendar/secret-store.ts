import { bytesToHex } from '@noble/hashes/utils.js';
import type { DeviceSecretIdentity, SharingCryptoGateway } from '../crypto.ts';
import { createDeviceIdentity, sharedDocumentDigest, validateDeviceSecretIdentity } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import type { PrivateCalendarTrustAnchor, ProtectedPrivateCalendarCheckpoint, SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority } from './authority.ts';
import { privateCalendarAuthorityFromProtectedCheckpoint, snapshotPrivateCalendarAuthority, verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from './authority.ts';
import { canonicalJson } from '../operations.ts';
import type { WrappedPrivateCalendarKey } from './key-envelope.ts';
import { createPrivateCalendarAccountKey, snapshotPrivateCalendarWrappedKey, unwrapPrivateCalendarKey } from './key-envelope.ts';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';

interface SecretState {
  schemaVersion: 1; ownerUserId: string; identity: DeviceSecretIdentity;
  anchor: PrivateCalendarTrustAnchor | null; checkpoint: ProtectedPrivateCalendarCheckpoint | null;
  origin: 'firstDeviceSetup' | 'approvedPairing' | null;
  keys: { keyVersion: number; value: string }[];
}
export interface PrivateCalendarSecretPort {
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
  crypto: SharingCryptoGateway;
  assertOwner(userId: string): void | Promise<void>;
  /** A process-safe lock is required: an in-memory promise queue cannot protect a second Native worker. */
  exclusive<T>(userId: string, work: () => Promise<T>): Promise<T>;
}
const MAX_KEYS = 1024;
const checkpoint = (value: VerifiedPrivateCalendarAuthority): ProtectedPrivateCalendarCheckpoint => ({ signed: value.signed, signer: value.signer, keyIssuer: value.keyIssuer });

function stateFromProtectedStorage(raw: string, userId: string): SecretState {
  if (raw.length > 128 * 1024) throw new Error('本人用の安全な保存領域が上限を超えています。');
  let state: SecretState;
  try { state = JSON.parse(raw); } catch { throw new Error('本人用の保存情報を確認できません。再生成せず復旧を確認してください。'); }
  exactRecord(state, ['schemaVersion', 'ownerUserId', 'identity', 'anchor', 'checkpoint', 'origin', 'keys']);
  if (state.schemaVersion !== 1 || state.ownerUserId !== userId) throw new Error('本人用の保存アカウントが一致しません。');
  exactRecord(state.identity, ['deviceId', 'signingPublicKey', 'agreementPublicKey', 'signingSecretKey', 'agreementSecretKey']);
  state.identity = validateDeviceSecretIdentity(state.identity);
  if (!Array.isArray(state.keys) || state.keys.length > MAX_KEYS) throw new Error('本人用の鍵履歴が無効です。');
  const authority = state.checkpoint && state.anchor ? privateCalendarAuthorityFromProtectedCheckpoint(state.checkpoint, state.anchor) : null;
  if (authority && authority.signed.body.ownerUserId !== userId) throw new Error('本人用の信頼アカウントが一致しません。');
  if (!authority && (state.anchor !== null || state.checkpoint !== null || state.origin !== null || state.keys.length)
    || authority && !['firstDeviceSetup', 'approvedPairing'].includes(state.origin ?? '')) throw new Error('本人用の信頼情報が不完全です。');
  let previous = 0;
  for (const key of state.keys) {
    exactRecord(key, ['keyVersion', 'value']); positiveInteger(key.keyVersion); hexBytes(key.value, 32);
    if (key.keyVersion <= previous || key.keyVersion > (authority?.signed.body.keyVersion ?? 0)) throw new Error('本人用の鍵世代が一致しません。');
    previous = key.keyVersion;
  }
  return state;
}
function currentAuthority(state: SecretState, expected?: VerifiedPrivateCalendarAuthority): VerifiedPrivateCalendarAuthority {
  if (!state.anchor || !state.checkpoint) throw new Error('本人端末の信頼を先に確認してください。');
  const authority = privateCalendarAuthorityFromProtectedCheckpoint(state.checkpoint, state.anchor);
  if (expected && (authority.digest !== expected.digest || authority.anchor.rootDigest !== expected.anchor.rootDigest)) throw new Error('本人端末の設定が更新されています。再読込してください。');
  return authority;
}
function approvedAuthority(state: SecretState, expected: VerifiedPrivateCalendarAuthority): VerifiedPrivateCalendarAuthority {
  const authority = currentAuthority(state, expected);
  if (!authority.signed.body.devices.some((device) => device.deviceId === state.identity.deviceId)) throw new Error('この本人端末の承認は解除されています。');
  return authority;
}
function requiredState(state: SecretState | null): SecretState {
  if (!state) throw new Error('本人端末を先に準備してください。既存の鍵は自動で置き換えません。'); return state;
}

/** Read only the protected vault while its caller already holds the same UID's SQLite lock. */
export function assertPrivateCalendarProtectedAuthority(raw: string | null, userId: string, expected: VerifiedPrivateCalendarAuthority, requireMain = false): void {
  assertSharedIdentifier(userId);
  const state = requiredState(raw === null ? null : stateFromProtectedStorage(raw, userId));
  const authority = approvedAuthority(state, expected);
  if (requireMain && authority.signed.body.mainDeviceId !== state.identity.deviceId) throw new Error('本人用Calendarの送信はメイン端末だけが行えます。');
}

/** No remove/reset API. Only explicitly confirmed trust and immutable key generations enter protected storage. */
export function createPrivateCalendarSecretStore(port: PrivateCalendarSecretPort) {
  async function transact<T>(userId: string, work: (state: SecretState | null) => Promise<{ value: T; write?: SecretState }>): Promise<T> {
    assertSharedIdentifier(userId); await port.assertOwner(userId);
    let prepared: unknown;
    try {
      const value = await port.exclusive(userId, async () => {
        await port.assertOwner(userId);
        const name = `private-calendar-state:${userId}`; const saved = await port.vault.getItem(name); await port.assertOwner(userId);
        const state = saved === null ? null : stateFromProtectedStorage(saved, userId);
        const result = await work(state); prepared = result.value;
        await port.assertOwner(userId);
        if (result.write) await port.vault.setItem(name, JSON.stringify(result.write));
        await port.assertOwner(userId); return result.value;
      });
      // The lock may still commit asynchronously after the vault callback returned.
      await port.assertOwner(userId); return value;
    } catch (error) { if (prepared instanceof Uint8Array) prepared.fill(0); throw error; }
  }
  return {
    identity(userId: string) { return transact(userId, async (state) => {
      if (state) return { value: state.identity };
      const identity = await createDeviceIdentity(port.crypto);
      return { value: identity, write: { schemaVersion: 1, ownerUserId: userId, identity, anchor: null, checkpoint: null, origin: null, keys: [] } };
    }); },
    authority(userId: string) { return transact(userId, async (state) => ({ value: state?.checkpoint ? currentAuthority(state) : null })); },
    confirmTrust(userId: string, authority: VerifiedPrivateCalendarAuthority, confirmation: 'firstDeviceSetup' | 'approvedPairing') {
      return transact(userId, async (value) => {
        const state = requiredState(value); const body = authority.signed.body;
        if (body.ownerUserId !== userId || !body.devices.some((device) => device.deviceId === state.identity.deviceId)
          || !['firstDeviceSetup', 'approvedPairing'].includes(confirmation)) throw new Error('本人が確認した端末の信頼情報が一致しません。');
        if (state.checkpoint) { currentAuthority(state, authority); return { value: authority }; }
        if (confirmation === 'firstDeviceSetup' && (body.revision !== 1 || body.keyVersion !== 1 || body.mainDeviceId !== state.identity.deviceId)) throw new Error('初回端末の設定を確認してください。');
        return { value: authority, write: { ...state, anchor: authority.anchor, checkpoint: checkpoint(authority), origin: confirmation } };
      });
    },
    async acceptAuthorityUpdate(userId: string, incoming: SignedPrivateCalendarAuthority) {
      const owned = snapshotPrivateCalendarAuthority(incoming);
      return transact(userId, async (value) => {
        const state = requiredState(value); const before = currentAuthority(state);
        if (sharedDocumentDigest(owned) === before.digest) return { value: before };
        const next = verifyPrivateCalendarAuthorityUpdate(before, owned);
        return { value: next, write: { ...state, checkpoint: checkpoint(next) } };
      });
    },
    async recoverKeyIssuerHistory(userId: string, history: readonly SignedPrivateCalendarAuthority[]) {
      if (!Array.isArray(history) || !history.length || history.length > 4096) throw new Error('本人用の認証履歴の件数を確認してください。');
      let size = 0;
      const owned = history.map((value) => {
        const copy = snapshotPrivateCalendarAuthority(value); size += canonicalJson(copy).length;
        if (size > 4 * 1024 * 1024) throw new Error('本人用の認証履歴が上限を超えています。自動で鍵を生成せず復旧を確認してください。'); return copy;
      });
      return transact(userId, async (value) => {
        const state = requiredState(value); const current = currentAuthority(state);
        let restored = verifyPrivateCalendarRoot(owned[0], current.anchor);
        for (const signed of owned.slice(1)) restored = verifyPrivateCalendarAuthorityUpdate(restored, signed);
        if (restored.digest !== current.digest) throw new Error('現在の本人用設定までの署名履歴が揃っていません。');
        return { value: restored, ...(canonicalJson(restored.keyIssuer) === canonicalJson(current.keyIssuer) ? {}
          : { write: { ...state, checkpoint: checkpoint(restored) } }) };
      });
    },
    currentKey(userId: string, expected: VerifiedPrivateCalendarAuthority) { return transact(userId, async (value) => {
      const state = requiredState(value); const authority = approvedAuthority(state, expected);
      const saved = state.keys.find((key) => key.keyVersion === authority.signed.body.keyVersion);
      return { value: saved ? hexBytes(saved.value, 32) : null };
    }); },
    createCurrentKey(userId: string, expected: VerifiedPrivateCalendarAuthority) { return transact(userId, async (value) => {
      const state = requiredState(value); const authority = approvedAuthority(state, expected); const body = authority.signed.body;
      const saved = state.keys.find((key) => key.keyVersion === body.keyVersion); if (saved) return { value: hexBytes(saved.value, 32) };
      if (authority.keyIssuer?.deviceId !== state.identity.deviceId) throw new Error('承認済みの鍵生成端末から受け取るか、署名履歴を確認してください。同じ世代に別の鍵は生成しません。');
      if (state.keys.length >= MAX_KEYS) throw new Error('鍵履歴の保存上限です。既存データの保持を確認してください。');
      const key = await createPrivateCalendarAccountKey(port.crypto);
      try {
        const encoded = bytesToHex(key); if (state.keys.some((previous) => previous.value === encoded)) throw new Error('新しい本人用の鍵を生成できませんでした。');
        return { value: key.slice(), write: { ...state, keys: [...state.keys, { keyVersion: body.keyVersion, value: encoded }] } };
      } finally { key.fill(0); }
    }); },
    async receiveCurrentKey(userId: string, expected: VerifiedPrivateCalendarAuthority, incoming: WrappedPrivateCalendarKey) {
      const wrapped = snapshotPrivateCalendarWrappedKey(incoming);
      return transact(userId, async (value) => {
        const state = requiredState(value); const authority = approvedAuthority(state, expected);
        const key = await unwrapPrivateCalendarKey(port.crypto, wrapped, authority, state.identity);
        try {
          const encoded = bytesToHex(key); const keyVersion = authority.signed.body.keyVersion;
          const saved = state.keys.find((key) => key.keyVersion === keyVersion);
          if (saved && saved.value !== encoded) throw new Error('同じ世代に異なる本人用の鍵があります。自動で置き換えません。');
          if (saved) return { value: key.slice() };
          if (state.keys.length >= MAX_KEYS) throw new Error('鍵履歴の保存上限です。既存データの保持を確認してください。');
          return { value: key.slice(), write: { ...state, keys: [...state.keys, { keyVersion, value: encoded }].sort((a, b) => a.keyVersion - b.keyVersion) } };
        } finally { key.fill(0); }
      });
    },
  };
}
