import { sharedDocumentDigest } from '../crypto.ts';
import { sealPrivateCalendarCache } from '../private-calendar/cache-crypto.ts';
import type { PrivateCalendarCryptoGateway } from '../private-calendar/crypto-gateway.ts';
import type { createPrivateCalendarSecretStore } from '../private-calendar/secret-store.ts';
import type { createPrivateCalendarCacheStorage } from '../../../platform/storage/private-calendar-cache.ts';
import { auditPrivateCalendarStoredState, PRIVATE_CALENDAR_STORE_QA_USER_ID } from './private-calendar-store-audit.ts';

/** Explicit, isolated QA only: no Google token, account data, network, or shared-group store. */
export async function auditPrivateCalendarCacheState(input: { development: boolean; crypto: PrivateCalendarCryptoGateway;
  store: ReturnType<typeof createPrivateCalendarSecretStore>; cache: ReturnType<typeof createPrivateCalendarCacheStorage> }) {
  if (!input.development) throw new Error('開発ビルドだけで使用できます。');
  const base = await auditPrivateCalendarStoredState(input); const { store, cache, crypto } = input;
  const userId = PRIVATE_CALENDAR_STORE_QA_USER_ID; const authority = await store.authority(userId);
  if (!authority) throw new Error('検査用の保存済み認証を確認できません。');
  const identity = await store.identity(userId); const accountKey = await store.currentKey(userId, authority);
  if (!accountKey) throw new Error('検査用の鍵を確認できません。自動再生成はしません。');
  try {
    const calendarBinding = 'development-private-calendar-cache-v1'; const options = { authority, calendarBinding, accountKey };
    const before = await cache.status(authority); const existing = await cache.read(options);
    const checks = [...base.checks];
    const assert = (condition: boolean, label: string) => { if (!condition) throw new Error(`検査に失敗：${label}`); checks.push(label); };
    assert(before ? before.authorityCurrent && existing?.intervals.length === 20_000 : existing === null, '既存の完全なキャッシュと全区間の有無を確認');
    const sequence = (before?.cursor.sequence ?? 0) + 1;
    if (!Number.isSafeInteger(sequence)) throw new Error('検査用の連番上限です。自動初期化しません。');
    const start = Date.parse('2026-10-28T00:00:00.000Z');
    const intervals = Array.from({ length: 20_000 }, (_, index) => ({ start: new Date(start + index * 120_000).toISOString(), end: new Date(start + index * 120_000 + 60_000).toISOString() }));
    const body = { ownerUserId: userId, accountGeneration: authority.signed.body.accountGeneration, mainDeviceId: identity.deviceId,
      mainRevision: authority.signed.body.revision, calendarBinding, timeZone: 'Asia/Tokyo', fetchedAt: new Date(start).toISOString(),
      coverage: { start: new Date(start).toISOString(), end: new Date(start + 30 * 24 * 60 * 60 * 1000).toISOString() }, intervals };
    const encrypted = await sealPrivateCalendarCache(crypto, { ...options, cache: body, mainDevice: identity, sequence });
    const digest = sharedDocumentDigest(encrypted.manifest); await cache.save(encrypted, { ...options, origin: 'local' });
    const saved = await cache.status(authority);
    assert(saved?.pending === true && saved.cursor.manifestDigest === digest && encrypted.chunks.length > 1, '全分割・保存位置・送信待ちを同時に保存');
    await cache.fail(authority, digest, 1, 'offline', 0.5);
    const held = await cache.pending(authority, 1); const retry = await cache.pending(authority, 30_001);
    assert(held === null && retry?.manifestDigest === digest && retry.attempts === 1 && retry.encrypted.chunks.every((part, index) =>
      part.encryptedPayload === encrypted.chunks[index].encryptedPayload && part.salt === encrypted.chunks[index].salt && part.nonce === encrypted.chunks[index].nonce), '再送待ちでも同じ暗号文を保持');
    await cache.acknowledge(authority, digest); await cache.save(encrypted, { ...options, origin: 'local' });
    const pending = await cache.pending(authority, 30_001); const restored = await cache.read(options);
    assert(pending === null && restored?.intervals.length === intervals.length && restored.intervals.every((part, index) =>
      part.start === intervals[index].start && part.end === intervals[index].end), '送信確認後は再登録せず2万区間を復元');
    return { ...base, mode: before ? 'restored' as const : 'created' as const, checks, sequence, chunkCount: encrypted.chunks.length };
  } finally { accountKey.fill(0); }
}
