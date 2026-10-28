import type { createPrivateCalendarSecretStore } from './secret-store.ts';
import type { createPrivateCalendarPairingStorage } from '../../../platform/storage/private-calendar-pairing.ts';
import type { createPrivateCalendarAuthorityIntentStorage } from '../../../platform/storage/private-calendar-authority-intents.ts';
import type { createPrivateCalendarCloud } from '../../../platform/sharing/private-calendar-cloud.ts';
import type { createPrivateCalendarAuthoritySync } from './authority-sync.ts';
import { collectPrivateCalendarAuthorityHistory } from './authority-sync.ts';
import type { createPrivateCalendarKeyDelivery } from './key-delivery.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from './pairing.ts';
import { privateCalendarPairingApproval, snapshotPrivateCalendarPairingReference, verifyPrivateCalendarPairingRequest } from './pairing.ts';
import { verifyPrivateCalendarRoot } from './authority.ts';
import { canonicalJson } from '../operations.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { assertSharedIdentifier } from '../identifier.ts';

type Cloud = Pick<ReturnType<typeof createPrivateCalendarCloud>, 'authorityPage' | 'readKey'>;
export function createPrivateCalendarPairingController(port: { userId: string; secrets: ReturnType<typeof createPrivateCalendarSecretStore>;
  candidates: ReturnType<typeof createPrivateCalendarPairingStorage>; intents: ReturnType<typeof createPrivateCalendarAuthorityIntentStorage>;
  authoritySync: ReturnType<typeof createPrivateCalendarAuthoritySync>; delivery: ReturnType<typeof createPrivateCalendarKeyDelivery>; cloud: Cloud }) {
  const { userId, secrets, candidates, intents, authoritySync, delivery, cloud } = port; assertSharedIdentifier(userId);
  async function readPinnedHistory(reference: PrivateCalendarPairingReference) {
    if (reference.anchor.ownerUserId !== userId) throw new Error('確認した本人用アカウントが異なります。');
    const page = await cloud.authorityPage(0); if (!page?.authorities[0]) throw new Error('本人端末の署名履歴がありません。');
    const root = verifyPrivateCalendarRoot(page.authorities[0], reference.anchor);
    return collectPrivateCalendarAuthorityHistory(cloud, root, page);
  }
  return {
    /** The caller must show and explicitly confirm the source device's pin/reference before this action. */
    async prepareConfirmedReference(reference: PrivateCalendarPairingReference) {
      const owned = snapshotPrivateCalendarPairingReference(reference);
      const checked = await readPinnedHistory(owned);
      if (checked.authority.digest !== owned.authorityDigest || checked.authority.signed.body.revision !== owned.authorityRevision) throw new Error('確認元の端末設定が古くなっています。新しい確認情報を交換してください。');
      return candidates.prepare(owned, await secrets.identity(userId));
    },
    /** Explicit approval on an already approved device; never invoke while just scanning or opening a link. */
    async approve(request: PrivateCalendarPairingRequest) {
      const owned = verifyPrivateCalendarPairingRequest(request); const body = owned.body;
      if (body.ownerUserId !== userId) throw new Error('本人用の別アカウントの端末は承認できません。');
      const pending = await intents.readPending();
      if (pending) {
        if (pending.signed.body.previousDigest !== body.authorityDigest || pending.rootDigest !== body.rootDigest
          || !pending.signed.body.devices.some(device => canonicalJson(device) === canonicalJson(body.device))) throw new Error('別の本人端末の変更が送信待ちです。元の変更を先に確認してください。');
        const resumed = await authoritySync.resume(); if (resumed.kind === 'review') return resumed;
      }
      const checked = await authoritySync.refresh(); const current = checked.authority;
      if (current.anchor.rootDigest !== body.rootDigest || current.anchor.accountGeneration !== body.accountGeneration
        || !checked.history[body.authorityRevision - 1] || sharedDocumentDigest(checked.history[body.authorityRevision - 1]) !== body.authorityDigest) throw new Error('確認依頼の信頼pin・元の端末設定が異なります。');
      const approved = current.signed.body.devices.some(device => canonicalJson(device) === canonicalJson(body.device));
      if (!approved) {
        const change = privateCalendarPairingApproval(owned, current); const result = await authoritySync.change(change.change);
        if (result.kind === 'review') return result;
      }
      const queued = await delivery.queueApprovedDevices(); const sent = await delivery.flush({ force: true });
      return { kind: 'approved' as const, deviceId: body.device.deviceId, queued, delivery: sent };
    },
    async join() {
      const candidate = await candidates.read(); if (!candidate) throw new Error('確認した本人端末の情報を先に準備してください。');
      const body = candidate.request.body;
      const reference = snapshotPrivateCalendarPairingReference({ anchor: { ownerUserId: body.ownerUserId, accountGeneration: body.accountGeneration, rootDigest: body.rootDigest },
        authorityDigest: body.authorityDigest, authorityRevision: body.authorityRevision });
      const existing = await secrets.authority(userId);
      const checked = existing ? await authoritySync.refresh() : await readPinnedHistory(reference); const current = checked.authority;
      if (!checked.history[body.authorityRevision - 1] || sharedDocumentDigest(checked.history[body.authorityRevision - 1]) !== body.authorityDigest
        || !current.signed.body.devices.some(device => canonicalJson(device) === canonicalJson(body.device))) throw new Error('この本人端末の承認がまだないか、承認が解除されています。');
      if (!existing) await secrets.confirmTrust(userId, current, 'approvedPairing');
      if (!await candidates.markApproved(sharedDocumentDigest(candidate.request))) throw new Error('本人端末の確認情報が更新されています。');
      let key = await secrets.currentKey(userId, current);
      try {
        if (!key) {
          // Only the generation's signed issuer may create it; other devices remain awaiting delivery.
          await delivery.queueApprovedDevices(); key = await secrets.currentKey(userId, current);
        }
        if (!key) {
          const wrapped = await cloud.readKey(current, body.device.deviceId);
          if (wrapped) { await secrets.receiveCurrentKey(userId, current, wrapped); key = await secrets.currentKey(userId, current); }
        }
        return { kind: key ? 'ready' as const : 'awaitingKey' as const, deviceId: body.device.deviceId, authorityDigest: current.digest };
      } finally { key?.fill(0); }
    },
  };
}
