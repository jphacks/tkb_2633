import { hkdf } from '@noble/hashes/hkdf.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import type { DeviceSecretIdentity } from '../crypto.ts';
import { sharedDocumentDigest, signSharedDocument, validateDeviceSecretIdentity, verifySharedDocument } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import type { PrivateBusyCache } from '../v2/private-availability.ts';
import { validatedPrivateBusyIntervals } from '../v2/private-availability.ts';
import { instantMilliseconds } from '../v2/date-target.ts';
import type { VerifiedPrivateCalendarAuthority } from './authority.ts';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';
import type { PrivateCalendarCryptoGateway } from './crypto-gateway.ts';

export const PRIVATE_CALENDAR_CACHE_SUITE = 'liflow-private-calendar-cache-aes256gcm-hkdfsha256-ed25519-v1';
export const PRIVATE_CALENDAR_CHUNK_BYTES = 64 * 1024;
export const MAX_PRIVATE_CALENDAR_CACHE_BYTES = 2 * 1024 * 1024;
const MAX_CHUNKS = MAX_PRIVATE_CALENDAR_CACHE_BYTES / PRIVATE_CALENDAR_CHUNK_BYTES;
interface CacheHeader {
  schemaVersion: 1; suite: typeof PRIVATE_CALENDAR_CACHE_SUITE;
  ownerUserId: string; accountGeneration: string; keyVersion: number; mainDeviceId: string; mainRevision: number;
  authorityDigest: string; cacheId: string; sequence: number; chunkCount: number;
}
export interface PrivateCalendarCacheManifest { body: CacheHeader & { chunkDigests: string[] }; signature: string }
export interface PrivateCalendarCacheChunk { index: number; salt: string; nonce: string; encryptedPayload: string }
export interface EncryptedPrivateCalendarCache { manifest: PrivateCalendarCacheManifest; chunks: PrivateCalendarCacheChunk[] }
const HEADER_FIELDS = ['schemaVersion', 'suite', 'ownerUserId', 'accountGeneration', 'keyVersion', 'mainDeviceId', 'mainRevision', 'authorityDigest', 'cacheId', 'sequence', 'chunkCount'];
const encoder = new TextEncoder();
const utf8 = (value: unknown) => encoder.encode(canonicalJson(value));

function normalizedCache(value: PrivateBusyCache, authority: VerifiedPrivateCalendarAuthority, calendarBinding: string): PrivateBusyCache {
  const body = authority.signed.body; assertSharedIdentifier(calendarBinding);
  const intervals = validatedPrivateBusyIntervals(value); const fetchedAt = instantMilliseconds(value.fetchedAt);
  if (value.ownerUserId !== body.ownerUserId || value.accountGeneration !== body.accountGeneration
    || value.mainDeviceId !== body.mainDeviceId || value.mainRevision !== body.revision || value.calendarBinding !== calendarBinding) throw new Error('本人用Calendarの接続先・メイン端末が変わりました。');
  const start = instantMilliseconds(value.coverage.start); const end = instantMilliseconds(value.coverage.end);
  if (end - start > 367 * 24 * 60 * 60 * 1000) throw new Error('本人用Calendarの取得範囲が長すぎます。');
  return { ...value, fetchedAt: new Date(fetchedAt).toISOString(),
    coverage: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
    intervals: intervals.map((range) => ({ start: new Date(range.start).toISOString(), end: new Date(range.end).toISOString() })) };
}
function chunkAad(header: CacheHeader, chunk: Pick<PrivateCalendarCacheChunk, 'index' | 'salt' | 'nonce'>): Uint8Array {
  return utf8({ ...header, index: chunk.index, salt: chunk.salt, nonce: chunk.nonce });
}
async function chunkDigest(crypto: PrivateCalendarCryptoGateway, chunk: Pick<PrivateCalendarCacheChunk, 'index' | 'salt' | 'nonce'>, ciphertext: Uint8Array): Promise<string> {
  // Hash ciphertext bytes directly. Canonicalizing their 2x hexadecimal string
  // needlessly encodes megabytes of text on the mobile JS thread.
  const context = utf8({ suite: `${PRIVATE_CALENDAR_CACHE_SUITE}:part`, index: chunk.index, salt: chunk.salt, nonce: chunk.nonce, bytes: ciphertext.length });
  if (!crypto.digestSha256) return bytesToHex(sha256.create().update(context).update(ciphertext).digest());
  const bytes = new Uint8Array(context.length + ciphertext.length); bytes.set(context); bytes.set(ciphertext, context.length);
  const digest = await crypto.digestSha256(bytes);
  if (digest.length !== 32) throw new Error('本人用Calendarの暗号文を検証できません。');
  return bytesToHex(digest);
}
function checkHeader(manifest: PrivateCalendarCacheManifest, authority: VerifiedPrivateCalendarAuthority): CacheHeader {
  exactRecord(manifest, ['body', 'signature']); exactRecord(manifest.body, [...HEADER_FIELDS, 'chunkDigests']);
  const { chunkDigests, ...header } = manifest.body; const expected = authority.signed.body;
  if (header.schemaVersion !== 1 || header.suite !== PRIVATE_CALENDAR_CACHE_SUITE || header.ownerUserId !== expected.ownerUserId
    || header.accountGeneration !== expected.accountGeneration || header.authorityDigest !== authority.digest
    || header.keyVersion !== expected.keyVersion || header.mainDeviceId !== expected.mainDeviceId || header.mainRevision !== expected.revision) throw new Error('本人用Calendarの鍵・メイン端末の世代が異なります。');
  hexBytes(header.cacheId, 32); positiveInteger(header.sequence); positiveInteger(header.chunkCount);
  if (header.chunkCount > MAX_CHUNKS || !Array.isArray(chunkDigests) || chunkDigests.length !== header.chunkCount) throw new Error('本人用Calendarの分割情報が無効です。');
  chunkDigests.forEach((digest) => hexBytes(digest, 32)); hexBytes(manifest.signature, 64);
  const main = expected.devices.find((device) => device.deviceId === expected.mainDeviceId)!;
  verifySharedDocument(manifest.body, manifest.signature, main);
  return header;
}
/** Raw intervals and the Google binding stay inside ciphertext. Never pass a group key here. */
export async function sealPrivateCalendarCache(crypto: PrivateCalendarCryptoGateway, input: {
  cache: PrivateBusyCache; authority: VerifiedPrivateCalendarAuthority; calendarBinding: string;
  accountKey: Uint8Array; mainDevice: DeviceSecretIdentity; sequence: number;
}): Promise<EncryptedPrivateCalendarCache> {
  if (input.accountKey.length !== 32 || input.mainDevice.deviceId !== input.authority.signed.body.mainDeviceId) throw new Error('Calendarの取得は承認済みのメイン端末だけが行えます。');
  input = { ...input, mainDevice: validateDeviceSecretIdentity(input.mainDevice) };
  positiveInteger(input.sequence);
  // The strictly validated private body may contain 20,000 intervals. Group
  // canonicalJson deliberately limits shared arrays to 4,096 and stays intact.
  const plain = encoder.encode(JSON.stringify(normalizedCache(input.cache, input.authority, input.calendarBinding)));
  input = { ...input, accountKey: input.accountKey.slice() };
  try {
    if (plain.length > MAX_PRIVATE_CALENDAR_CACHE_BYTES) throw new Error('本人用Calendar情報が保存上限を超えています。');
    const id = await crypto.randomBytes(32); if (id.length !== 32) throw new Error('安全な乱数を生成できません。');
    const authority = input.authority.signed.body;
    const header: CacheHeader = { schemaVersion: 1, suite: PRIVATE_CALENDAR_CACHE_SUITE, ownerUserId: authority.ownerUserId,
      accountGeneration: authority.accountGeneration, keyVersion: authority.keyVersion, mainDeviceId: authority.mainDeviceId,
      mainRevision: authority.revision, authorityDigest: input.authority.digest, cacheId: bytesToHex(id),
      sequence: input.sequence, chunkCount: Math.ceil(plain.length / PRIVATE_CALENDAR_CHUNK_BYTES) };
    const chunks: PrivateCalendarCacheChunk[] = []; const chunkDigests: string[] = [];
    for (let index = 0; index < header.chunkCount; index++) {
      const salt = await crypto.randomBytes(32); const nonce = await crypto.randomBytes(12);
      if (salt.length !== 32 || nonce.length !== 12) throw new Error('安全な乱数を生成できません。');
      const part = { index, salt: bytesToHex(salt), nonce: bytesToHex(nonce) }; const aad = chunkAad(header, part);
      const key = hkdf(sha256, input.accountKey, salt, aad, 32);
      try {
        const piece = plain.subarray(index * PRIVATE_CALENDAR_CHUNK_BYTES, (index + 1) * PRIVATE_CALENDAR_CHUNK_BYTES);
        const encrypted = await crypto.encrypt(key, nonce, piece, aad);
        if (encrypted.length !== piece.length + 16) throw new Error('本人用Calendarの暗号化に失敗しました。');
        chunks.push({ ...part, encryptedPayload: bytesToHex(encrypted) });
        chunkDigests.push(await chunkDigest(crypto, part, encrypted));
      } finally { key.fill(0); }
    }
    const body = { ...header, chunkDigests };
    const manifest = { body, signature: signSharedDocument(body, input.mainDevice) };
    checkHeader(manifest, input.authority);
    return { manifest, chunks };
  } finally { plain.fill(0); input.accountKey.fill(0); }
}
/** Bounded owned transport copy. Ciphertext digests are checked by verify/open, not by this snapshot alone. */
export function snapshotEncryptedPrivateCalendarCache(encrypted: EncryptedPrivateCalendarCache, authority: VerifiedPrivateCalendarAuthority): EncryptedPrivateCalendarCache {
  exactRecord(encrypted, ['manifest', 'chunks']);
  const header = checkHeader(encrypted.manifest, authority);
  if (!Array.isArray(encrypted.chunks) || encrypted.chunks.length !== header.chunkCount) throw new Error('本人用Calendarの取得が完了していません。');
  const seen = new Set<number>();
  const chunks = encrypted.chunks.map((chunk): PrivateCalendarCacheChunk => {
    exactRecord(chunk, ['index', 'salt', 'nonce', 'encryptedPayload']);
    if (!Number.isSafeInteger(chunk.index) || chunk.index < 0 || chunk.index >= header.chunkCount || seen.has(chunk.index)) throw new Error('本人用Calendarの分割順序が無効です。');
    seen.add(chunk.index); hexBytes(chunk.salt, 32); hexBytes(chunk.nonce, 12);
    if (typeof chunk.encryptedPayload !== 'string' || chunk.encryptedPayload.length <= 32 || chunk.encryptedPayload.length > (PRIVATE_CALENDAR_CHUNK_BYTES + 16) * 2
      || chunk.encryptedPayload.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(chunk.encryptedPayload)) throw new Error('本人用Calendarの暗号サイズが無効です。');
    if (chunk.index < header.chunkCount - 1 && chunk.encryptedPayload.length !== (PRIVATE_CALENDAR_CHUNK_BYTES + 16) * 2) throw new Error('本人用Calendarの分割サイズが異なります。');
    return { ...chunk };
  });
  return { manifest: { body: { ...header, chunkDigests: [...encrypted.manifest.body.chunkDigests] }, signature: encrypted.manifest.signature }, chunks };
}
async function inspectCiphertext(crypto: PrivateCalendarCryptoGateway, encrypted: EncryptedPrivateCalendarCache) {
  const parts: { chunk: PrivateCalendarCacheChunk; encrypted: Uint8Array; salt: Uint8Array; nonce: Uint8Array }[] = [];
  let total = 0;
  for (const chunk of encrypted.chunks) {
    const ciphertext = hexBytes(chunk.encryptedPayload, chunk.encryptedPayload.length / 2);
    if (await chunkDigest(crypto, chunk, ciphertext) !== encrypted.manifest.body.chunkDigests[chunk.index]) throw new Error('本人用Calendarの改ざんを検出しました。');
    total += ciphertext.length - 16; if (total > MAX_PRIVATE_CALENDAR_CACHE_BYTES) throw new Error('本人用Calendar情報が保存上限を超えています。');
    parts[chunk.index] = { chunk, encrypted: ciphertext, salt: hexBytes(chunk.salt, 32), nonce: hexBytes(chunk.nonce, 12) };
  }
  return { parts, total };
}
/** Returns the same owned bytes that passed signature and all-part digest verification; no decryption key is needed. */
export async function verifyPrivateCalendarCacheCiphertext(crypto: PrivateCalendarCryptoGateway, encrypted: EncryptedPrivateCalendarCache,
  authority: VerifiedPrivateCalendarAuthority): Promise<EncryptedPrivateCalendarCache> {
  const owned = snapshotEncryptedPrivateCalendarCache(encrypted, authority); await inspectCiphertext(crypto, owned); return owned;
}
/** Verify every part before exposing any plaintext or replacing the last complete local cache. */
export async function openPrivateCalendarCache(crypto: PrivateCalendarCryptoGateway, encrypted: EncryptedPrivateCalendarCache, input: {
  authority: VerifiedPrivateCalendarAuthority; calendarBinding: string; accountKey: Uint8Array;
}): Promise<PrivateBusyCache> {
  encrypted = snapshotEncryptedPrivateCalendarCache(encrypted, input.authority);
  if (input.accountKey.length !== 32) throw new Error('本人用Calendarの鍵が無効です。');
  const { chunkDigests: _digests, ...header } = encrypted.manifest.body;
  input = { ...input, accountKey: input.accountKey.slice() };
  let plain: Uint8Array | undefined;
  try {
    const { parts, total } = await inspectCiphertext(crypto, encrypted);
    plain = new Uint8Array(total); let offset = 0;
    for (const { chunk, encrypted: ciphertext, salt, nonce } of parts) {
      const aad = chunkAad(header, chunk); const key = hkdf(sha256, input.accountKey, salt, aad, 32);
      let piece: Uint8Array | undefined;
      try {
        piece = await crypto.decrypt(key, nonce, ciphertext, aad);
        if (piece.length !== ciphertext.length - 16) throw new Error('本人用Calendarの復号に失敗しました。');
        plain.set(piece, offset); offset += piece.length;
      } finally { key.fill(0); piece?.fill(0); }
    }
    return normalizedCache(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain)), input.authority, input.calendarBinding);
  } finally { plain?.fill(0); input.accountKey.fill(0); }
}

export interface PrivateCalendarCacheCursor { accountGeneration: string; authorityRevision: number; authorityDigest: string; sequence: number; manifestDigest: string }
export function snapshotPrivateCalendarCacheCursor(value: PrivateCalendarCacheCursor): PrivateCalendarCacheCursor {
  exactRecord(value, ['accountGeneration', 'authorityRevision', 'authorityDigest', 'sequence', 'manifestDigest']);
  positiveInteger(value.sequence); positiveInteger(value.authorityRevision);
  hexBytes(value.accountGeneration, 32); hexBytes(value.authorityDigest, 32); hexBytes(value.manifestDigest, 32);
  return { ...value };
}
/** Persist this comparison with the complete cache in the same local transaction. Clock time never selects a winner. */
export function advancePrivateCalendarCacheCursor(previous: PrivateCalendarCacheCursor | null, manifest: PrivateCalendarCacheManifest,
  authority: VerifiedPrivateCalendarAuthority): { kind: 'new' | 'duplicate'; cursor: PrivateCalendarCacheCursor } {
  checkHeader(manifest, authority);
  const cursor = { accountGeneration: manifest.body.accountGeneration, authorityRevision: manifest.body.mainRevision,
    authorityDigest: authority.digest, sequence: manifest.body.sequence, manifestDigest: sharedDocumentDigest(manifest) };
  if (previous) {
    previous = snapshotPrivateCalendarCacheCursor(previous);
    if (previous.accountGeneration !== cursor.accountGeneration || cursor.authorityRevision < previous.authorityRevision
      || cursor.authorityRevision === previous.authorityRevision && cursor.authorityDigest !== previous.authorityDigest) throw new Error('本人用Calendarの認証世代を巻き戻せません。明示的な復旧が必要です。');
    if (previous.authorityDigest === cursor.authorityDigest) {
      if (cursor.sequence < previous.sequence || cursor.sequence === previous.sequence && cursor.manifestDigest !== previous.manifestDigest) throw new Error('古いCalendar情報または同じ連番の異なる内容を検出しました。');
      if (cursor.sequence === previous.sequence) return { kind: 'duplicate', cursor };
    }
  }
  return { kind: 'new', cursor };
}
