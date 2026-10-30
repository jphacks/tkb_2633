import type { createPrivateCalendarPairAuditContext } from '../../../platform/sharing/private-calendar-pair-audit';
import { createPrivateCalendarFirstDeviceSetup } from '../private-calendar/first-device-setup.ts';
import { privateCalendarPairingReference } from '../private-calendar/pairing.ts';
import type { PrivateCalendarPairingReference, PrivateCalendarPairingRequest } from '../private-calendar/pairing.ts';
import { sharedDocumentDigest } from '../crypto.ts';
import { sealPrivateCalendarCache } from '../private-calendar/cache-crypto.ts';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertPrivateCalendarCloudAuthority } from '../private-calendar/cloud-contract.ts';

export const PRIVATE_CALENDAR_PAIR_QA_STEPS = ['reference', 'request', 'approve', 'join', 'main', 'publish', 'receive', 'revoke', 'revoked'] as const;
export type PrivateCalendarPairQaStep = typeof PRIVATE_CALENDAR_PAIR_QA_STEPS[number];
export interface PrivateCalendarPairAuditResult {
  step: PrivateCalendarPairQaStep; deviceId: string; rootDigest: string; authorityDigest: string | null; mainDeviceId: string | null; keyProof: string | null;
  reference?: string; request?: string; cacheProof?: string; sequence?: number; chunkCount?: number; intervalCount?: number; restoredBeforeFetch?: boolean; checks: string[];
}
type Context = Awaited<ReturnType<typeof createPrivateCalendarPairAuditContext>>;
function payload<T>(raw: unknown): T {
  if (typeof raw !== 'string' || raw.length > 6000) throw new Error('検査用の公開確認情報が必要です。'); return JSON.parse(raw) as T;
}
/** Only the fixed synthetic two-device account may be used by this explicit QA action. */
export async function auditPrivateCalendarPair(development: boolean, step: PrivateCalendarPairQaStep, input: { reference?: unknown; request?: unknown; deviceId?: unknown }, ctx: Context): Promise<PrivateCalendarPairAuditResult> {
  if (!development) throw new Error('開発ビルドだけで使用できます。');
  if (ctx.userId !== 'development-calendar-native-pairing-e2e-v1' || !PRIVATE_CALENDAR_PAIR_QA_STEPS.includes(step)) throw new Error('検査専用の端末間設定が必要です。');
  const { reference: sourceReference, request: sourceRequest, deviceId: targetDeviceId } = input;
  const { userId, secrets, cloud, authoritySync, pair, delivery, cache, crypto } = ctx; const checks: string[] = [];
  const check = (value: unknown, label: string) => { if (!value) throw new Error(`検査に失敗：${label}`); checks.push(label); };
  let reference: string | undefined; let request: string | undefined;
  if (step === 'reference') {
    if (!await secrets.authority(userId)) await createPrivateCalendarFirstDeviceSetup({ userId, secrets, intents: ctx.intents, cloud }).prepareAndResume();
    const current = (await authoritySync.refresh()).authority; reference = JSON.stringify(privateCalendarPairingReference(current)); checks.push('専用Emulatorの受付と保護したrootを照合');
  } else if (step === 'request') {
    const candidate = await pair.prepareConfirmedReference(payload<PrivateCalendarPairingReference>(sourceReference)); request = JSON.stringify(candidate.request);
    const current = await secrets.authority(userId);
    check(!current || !current.signed.body.devices.some(device => device.deviceId === candidate.request.body.device.deviceId), '正式承認前の確認依頼を保護領域へ保存');
    const identity = await secrets.identity(userId);
    return { step, reference: JSON.stringify({ anchor: { ownerUserId: candidate.request.body.ownerUserId, accountGeneration: candidate.request.body.accountGeneration, rootDigest: candidate.request.body.rootDigest },
      authorityDigest: candidate.request.body.authorityDigest, authorityRevision: candidate.request.body.authorityRevision }), request, deviceId: identity.deviceId,
      rootDigest: candidate.request.body.rootDigest, authorityDigest: current?.digest ?? null, mainDeviceId: current?.signed.body.mainDeviceId ?? null, keyProof: null, checks };
  } else if (step === 'approve') {
    const result = await pair.approve(payload<PrivateCalendarPairingRequest>(sourceRequest)); check(result.kind === 'approved', '確認した公開鍵を明示承認して実サーバーへ反映');
    check(result.kind === 'approved' && result.delivery.kind === 'sent', '固定した暗号化配布鍵の受付を確認');
  } else if (step === 'join') {
    const joined = await pair.join(); check(joined.kind === 'ready', '確認したpinからの署名履歴と受信鍵を保護');
  } else if (step === 'main' || step === 'revoke') {
    if (typeof targetDeviceId !== 'string') throw new Error('確認した検査端末IDが必要です。');
    const current = (await authoritySync.refresh()).authority; const identity = await secrets.identity(userId);
    check(current.signed.body.devices.some(device => device.deviceId === targetDeviceId), '確認した検査端末だけを対象に変更');
    if (step === 'revoke' && targetDeviceId === identity.deviceId) throw new Error('この検査で自身の端末は解除しません。');
    const changed = await authoritySync.change({ devices: current.signed.body.devices.filter(device => step === 'main' || device.deviceId !== targetDeviceId),
      mainDeviceId: step === 'main' ? targetDeviceId : identity.deviceId, keyVersion: current.signed.body.keyVersion + (step === 'revoke' ? 1 : 0) });
    check(changed.kind !== 'review', '同じ変更の実受付と保護checkpointを確認');
    await delivery.queueApprovedDevices(); check((await delivery.flush({ force: true })).kind === 'sent', '現在の承認世代の配布を確認');
    if (step === 'revoke') { const latest = await secrets.authority(userId); if (!latest) throw new Error('設定がありません。'); const generated = await secrets.createCurrentKey(userId, latest); generated.fill(0); }
  } else if (step === 'revoked') {
    let denied = false;
    try { await pair.join(); } catch (error) { denied = error instanceof Error && error.message.includes('承認が解除されています'); }
    check(denied, '解除後の旧確認依頼で参加を再開できない');
    const current = await secrets.authority(userId); const identity = await secrets.identity(userId);
    check(current && !current.signed.body.devices.some(device => device.deviceId === identity.deviceId), '署名履歴から端末解除を確認');
    let blocked = false;
    try { if (current) { const value = await secrets.currentKey(userId, current); value?.fill(0); } }
    catch (error) { blocked = error instanceof Error && error.message.includes('承認は解除されています'); }
    check(blocked, '新世代の鍵の利用を拒否');
    return { step, deviceId: identity.deviceId, rootDigest: current!.anchor.rootDigest, authorityDigest: current!.digest, mainDeviceId: current!.signed.body.mainDeviceId, keyProof: null, checks };
  }
  const current = (await authoritySync.refresh()).authority; const identity = await secrets.identity(userId); let key = await secrets.currentKey(userId, current);
  try {
    if (!key || !crypto.digestSha256) throw new Error('検査用の保存鍵がありません。');
    const result: PrivateCalendarPairAuditResult = { step, deviceId: identity.deviceId, rootDigest: current.anchor.rootDigest, authorityDigest: current.digest,
      mainDeviceId: current.signed.body.mainDeviceId, keyProof: bytesToHex(await crypto.digestSha256(key)), checks, reference, request };
    if (step === 'publish' || step === 'receive') {
      const calendarBinding = 'development-private-pairing-calendar-v1'; const options = { authority: current, accountKey: key, calendarBinding };
      let encrypted;
      if (step === 'publish') {
        check(current.signed.body.mainDeviceId === identity.deviceId, '現在のメイン端末だけがcacheを公開');
        const pending = await cache.pending(current, Date.now(), { force: true });
        if (pending) encrypted = pending.encrypted;
        else {
          const before = await cache.status(current); const head = await cloud.readHead();
          if (!head) throw new Error('本人用cacheのサーバー位置がありません。'); assertPrivateCalendarCloudAuthority(head, current);
          const sequence = Math.max(before?.cursor.sequence ?? 0, head.cacheHead?.sequence ?? 0) + 1;
          const start = Date.parse('2026-10-28T00:00:00.000Z');
          const body = { ownerUserId: userId, accountGeneration: current.anchor.accountGeneration, mainDeviceId: identity.deviceId, mainRevision: current.signed.body.revision,
            calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: new Date(start).toISOString(), coverage: { start: new Date(start).toISOString(), end: new Date(start + 30 * 86400000).toISOString() },
            intervals: Array.from({ length: 20000 }, (_, index) => ({ start: new Date(start + index * 120000).toISOString(), end: new Date(start + index * 120000 + 60000).toISOString() })) };
          encrypted = await sealPrivateCalendarCache(crypto, { ...options, cache: body, mainDevice: identity, sequence }); await cache.save(encrypted, { ...options, origin: 'local' });
        }
        await cloud.uploadCache(current, encrypted); check(await cache.acknowledge(current, sharedDocumentDigest(encrypted.manifest)), '全暗号片の実受付を同じcursorで確認');
      } else {
        const before = await cache.status(current);
        if (before?.authorityCurrent) {
          const persisted = await cache.read(options); check(persisted?.intervals.length === 20000, '通信前に保存済み2万区間をSQLiteから復元');
          result.restoredBeforeFetch = true;
        }
        encrypted = await cloud.readCache(current); if (!encrypted) throw new Error('現在のメイン端末の完全なcacheがありません。');
        await cache.save(encrypted, { ...options, origin: 'remote' }); checks.push('別OSの完全な暗号文を本人用SQLiteへ保存');
      }
      const opened = await cache.read(options); check(opened?.intervals.length === 20000, '受信鍵で2万区間を復元');
      const start = Date.parse('2026-10-28T00:00:00.000Z');
      check(opened!.intervals.every((part, index) => part.start === new Date(start + index * 120000).toISOString() && part.end === new Date(start + index * 120000 + 60000).toISOString()), '全区間の時刻と順序を合成原本と照合');
      result.cacheProof = sharedDocumentDigest(encrypted.manifest); result.sequence = encrypted.manifest.body.sequence;
      result.chunkCount = encrypted.chunks.length; result.intervalCount = opened!.intervals.length;
    }
    await ctx.assertOtherUserDenied(); checks.push('実Rulesで別UIDの読取を拒否');
    check((await secrets.authority(userId))?.digest === current.digest, '検査中の本人設定とUIDが一致'); return result;
  } finally { key?.fill(0); key = null; }
}
