import type { PrivateCalendarAuthorityIntentPort } from './private-calendar-authority-intents.ts';
import type { ProtectedPrivateCalendarDeviceState } from '../../features/sharing/private-calendar/secret-store.ts';
import type { SignedPrivateCalendarAuthority } from '../../features/sharing/private-calendar/authority.ts';
import { snapshotPrivateCalendarAuthority, verifyPrivateCalendarAuthorityUpdate, samePrivateCalendarAuthorityConfiguration } from '../../features/sharing/private-calendar/authority.ts';
import { sharedDocumentDigest, verifySharedDocument } from '../../features/sharing/crypto.ts';
import { canonicalJson } from '../../features/sharing/operations.ts';
import { assertSharedIdentifier } from '../../features/sharing/identifier.ts';
import { exactRecord, hexBytes } from '../../features/sharing/private-calendar/validation.ts';

export interface PrivateCalendarSourceChoice { googleSubject: string | null }
export interface PrivateCalendarSourceProfile {
  schemaVersion: 1; ownerUserId: string; rootDigest: string;
  active: { googleSubject: string | null; authorityDigest: string; revision: number } | null;
  pending: { signed: SignedPrivateCalendarAuthority; digest: string; choice: PrivateCalendarSourceChoice } | null;
}
export interface PrivateCalendarSourcePort extends PrivateCalendarAuthorityIntentPort {
  vault: { getItem(key: string): Promise<string | null>; setItem(key: string, value: string): Promise<void> };
}
function choice(value: PrivateCalendarSourceChoice): PrivateCalendarSourceChoice {
  exactRecord(value, ['googleSubject']); if (value.googleSubject !== null) assertSharedIdentifier(value.googleSubject);
  return { googleSubject: value.googleSubject };
}
/** Subject bindings live only in the protected per-UID vault; never in group events or plaintext SQLite. */
export function createPrivateCalendarSourceStorage(port: PrivateCalendarSourcePort) {
  const { ownerUserId, vault } = port; assertSharedIdentifier(ownerUserId); const key = `private-calendar-source:${ownerUserId}`;
  function decode(raw: string | null, state: ProtectedPrivateCalendarDeviceState): PrivateCalendarSourceProfile | null {
    if (raw === null) return null; if (raw.length > 24_000) throw new Error('本人用Calendarの取得元設定が大きすぎます。');
    const value = JSON.parse(raw) as PrivateCalendarSourceProfile; exactRecord(value, ['schemaVersion', 'ownerUserId', 'rootDigest', 'active', 'pending']);
    if (!state.authority || value.schemaVersion !== 1 || value.ownerUserId !== ownerUserId || value.rootDigest !== state.authority.anchor.rootDigest) throw new Error('本人用Calendarの取得元と確認済みpinが異なります。');
    if (value.active) {
      exactRecord(value.active, ['googleSubject', 'authorityDigest', 'revision']); choice({ googleSubject: value.active.googleSubject }); hexBytes(value.active.authorityDigest, 32);
      if (!Number.isSafeInteger(value.active.revision) || value.active.revision < 2 || value.active.revision > state.authority.signed.body.revision) throw new Error('本人用Calendarの取得元の確定位置が異なります。');
    }
    if (value.pending) {
      exactRecord(value.pending, ['signed', 'digest', 'choice']); choice(value.pending.choice); hexBytes(value.pending.digest, 32);
      const signed = snapshotPrivateCalendarAuthority(value.pending.signed); const body = signed.body;
      if (sharedDocumentDigest(signed) !== value.pending.digest || body.ownerUserId !== ownerUserId || body.accountGeneration !== state.authority.anchor.accountGeneration
        || body.signerDeviceId !== state.identity.deviceId || body.mainDeviceId !== state.identity.deviceId || body.revision < 2) throw new Error('本人用Calendarの準備済み取得元が異なります。');
      verifySharedDocument(body, signed.signature, state.identity); value.pending.signed = signed;
    }
    return value;
  }
  async function locked<T>(work: (profile: PrivateCalendarSourceProfile | null, state: ProtectedPrivateCalendarDeviceState) => Promise<T>) {
    await port.assertOwner(ownerUserId);
    const result = await port.exclusive(ownerUserId, async () => {
      await port.assertOwner(ownerUserId); const state = await port.readProtected(); await port.assertOwner(ownerUserId);
      const raw = await vault.getItem(key); await port.assertOwner(ownerUserId); const result = await work(decode(raw, state), state);
      await port.assertOwner(ownerUserId); return result;
    });
    await port.assertOwner(ownerUserId); return result;
  }
  return {
    read() { return locked(async profile => profile); },
    prepare(signed: SignedPrivateCalendarAuthority, selected: PrivateCalendarSourceChoice) {
      const owned = snapshotPrivateCalendarAuthority(signed); const selectedChoice = choice(selected); const digest = sharedDocumentDigest(owned);
      return locked(async (profile, state) => {
        const current = state.authority;
        if (!current || current.signed.body.mainDeviceId !== state.identity.deviceId) throw new Error('Calendarの取得元は現在のメイン端末で設定してください。');
        const next = verifyPrivateCalendarAuthorityUpdate(current, owned); const before = current.signed.body; const after = next.signed.body;
        if (after.signerDeviceId !== state.identity.deviceId || !samePrivateCalendarAuthorityConfiguration(before, after)) throw new Error('取得元の変更と本人端末の変更を混ぜることはできません。');
        if (profile?.pending) {
          if (profile.pending.digest !== digest || canonicalJson(profile.pending.choice) !== canonicalJson(selectedChoice)) throw new Error('別の取得元の変更が確認待ちです。元の変更を先に確認してください。'); return profile.pending;
        }
        const pending = { signed: next.signed, digest, choice: selectedChoice };
        await vault.setItem(key, canonicalJson({ schemaVersion: 1, ownerUserId, rootDigest: current.anchor.rootDigest, active: profile?.active ?? null, pending }));
        return pending;
      });
    },
    /** The controller first verifies this exact target in the server-accepted pinned history. */
    commitAccepted(targetDigest: string, observedHeadDigest: string) {
      hexBytes(targetDigest, 32); hexBytes(observedHeadDigest, 32);
      return locked(async (profile, state) => {
        const pending = profile?.pending;
        if (!profile || !pending || pending.digest !== targetDigest || state.authority?.digest !== observedHeadDigest
          || state.authority.signed.body.revision < pending.signed.body.revision) return false;
        const active = { ...pending.choice, authorityDigest: pending.digest, revision: pending.signed.body.revision };
        await vault.setItem(key, canonicalJson({ ...profile, active, pending: null })); return true;
      });
    },
    /** Cancel only an explicitly reviewed losing proposal. Never restore a prior authority or remove keys. */
    dismissReviewed(targetDigest: string, observedHeadDigest: string) {
      hexBytes(targetDigest, 32); hexBytes(observedHeadDigest, 32);
      return locked(async (profile, state) => {
        if (!profile?.pending || profile.pending.digest !== targetDigest || state.authority?.digest !== observedHeadDigest
          || observedHeadDigest === targetDigest || state.authority.signed.body.revision < profile.pending.signed.body.revision) return false;
        await vault.setItem(key, canonicalJson({ ...profile, pending: null })); return true;
      });
    },
  };
}
