import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority, PrivateCalendarAuthorityChange } from './authority.ts';
import { snapshotPrivateCalendarAuthority, snapshotPrivateCalendarAuthorityChange, verifyPrivateCalendarAuthorityUpdate, verifyPrivateCalendarRoot } from './authority.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertPrivateCalendarCloudAuthority, PrivateCalendarCloudConflict } from './cloud-contract.ts';
import { assertSharedIdentifier } from '../identifier.ts';

type Cloud = Pick<ReturnType<typeof createPrivateCalendarCloud>, 'authorityPage' | 'commitAuthority'>;
/** Used for approval/recovery, not per-card rendering. A cloud checkpoint cannot substitute for the pinned signature chain. */
export async function collectPrivateCalendarAuthorityHistory(cloud: Pick<Cloud, 'authorityPage'>, expected: VerifiedPrivateCalendarAuthority) {
  const history: SignedPrivateCalendarAuthority[] = []; let current: VerifiedPrivateCalendarAuthority | null = null;
  let bytes = 0; let observedRevision = expected.signed.body.revision; let expectedFound = false;
  while (history.length < 4096) {
    const page = await cloud.authorityPage(history.length);
    if (!page || page.head.rootDigest !== expected.anchor.rootDigest || page.head.accountGeneration !== expected.anchor.accountGeneration
      || page.head.ownerUserId !== expected.anchor.ownerUserId || page.head.authorityRevision < observedRevision
      || !page.authorities.length || page.authorities.length > 100) throw new Error('本人端末の署名履歴と確認済みの設定が一致しません。');
    observedRevision = page.head.authorityRevision;
    for (const raw of page.authorities) {
      const signed = snapshotPrivateCalendarAuthority(raw); bytes += canonicalJson(signed).length;
      if (history.length >= 4096 || bytes > 4 * 1024 * 1024) throw new Error('本人端末の署名履歴が上限を超えています。');
      current = current ? verifyPrivateCalendarAuthorityUpdate(current, signed) : verifyPrivateCalendarRoot(signed, expected.anchor);
      history.push(signed);
      if (current.signed.body.revision === expected.signed.body.revision) {
        if (current.digest !== expected.digest) throw new Error('本人端末で保護した設定と署名履歴が分岐しています。'); expectedFound = true;
      }
    }
    if (current!.signed.body.revision === page.head.authorityRevision) {
      assertPrivateCalendarCloudAuthority(page.head, current!);
      if (!expectedFound) throw new Error('確認済みの本人端末の設定まで署名履歴がありません。');
      return { authority: current!, history };
    }
    if (current!.signed.body.revision > page.head.authorityRevision) throw new Error('本人端末の署名履歴の取得位置が異なります。');
  }
  throw new Error('本人端末の署名履歴が上限を超えています。');
}

export function createPrivateCalendarAuthoritySync(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>; cloud: Cloud }) {
  const { userId, secrets, intents, cloud } = port; assertSharedIdentifier(userId);
  async function refresh() {
    const before = await secrets.authority(userId); if (!before) throw new Error('本人端末の信頼を先に確認してください。');
    const collected = await collectPrivateCalendarAuthorityHistory(cloud, before);
    // Another runtime may have applied a prefix while the server pages were being read.
    let current = await secrets.authority(userId); if (!current) throw new Error('本人端末の信頼が変わりました。');
    for (;;) {
      const revision = current.signed.body.revision;
      if (!collected.history[revision - 1] || sharedDocumentDigest(collected.history[revision - 1]) !== current.digest) throw new Error('本人端末の設定が取得中に変わりました。再同期してください。');
      if (revision === collected.history.length) break;
      try { current = await secrets.acceptAuthorityUpdate(userId, collected.history[revision]); }
      catch (error) {
        const advanced = await secrets.authority(userId);
        if (!advanced || advanced.signed.body.revision <= revision) throw error;
        current = advanced;
      }
    }
    if (!current.keyIssuer) current = await secrets.recoverKeyIssuerHistory(userId, collected.history);
    return { ...collected, authority: current };
  }
  async function resume() {
    const saved = await intents.readPending(); if (!saved) return { kind: 'idle' as const };
    if (saved.current.digest === saved.signed.body.previousDigest) {
      const next = verifyPrivateCalendarAuthorityUpdate(saved.current, saved.signed);
      try { await cloud.commitAuthority(saved.current, next); }
      catch (error) { if (!(error instanceof PrivateCalendarCloudConflict)) throw error; }
    }
    const collected = await refresh();
    const accepted = collected.history[saved.signed.body.revision - 1];
    if (!accepted) throw new Error('本人端末の変更の受付がまだ確認できません。準備内容を保持して再同期してください。');
    if (sharedDocumentDigest(accepted) !== saved.digest) {
      return { kind: 'review' as const, intentDigest: saved.digest, observedCurrentDigest: collected.authority.digest };
    }
    if (!await intents.markAccepted(saved.digest, collected.authority)) throw new Error('本人端末の受付確認中に設定が変わりました。再同期してください。');
    return { kind: 'accepted' as const, authority: collected.authority, intentDigest: saved.digest };
  }
  return { refresh, resume, async change(change: PrivateCalendarAuthorityChange) {
    const owned = snapshotPrivateCalendarAuthorityChange(change);
    if (!await secrets.authority(userId)) throw new Error('本人端末の信頼を先に確認してください。');
    const saved = await intents.prepare(owned, await secrets.identity(userId));
    return saved ? resume() : { kind: 'idle' as const };
  }, dismissReviewed: intents.dismissReviewed };
}
