import { sharedDocumentDigest } from '../crypto.ts';
import { canonicalJson } from '../operations.ts';
import { MAX_PRIVATE_CALENDAR_AUTHORITY_DOCUMENT_BYTES } from './authority-history-limits.ts';
import { assertSharedIdentifier } from '../identifier.ts';
import type { SignedPrivateCalendarAuthority, VerifiedPrivateCalendarAuthority } from './authority.ts';
import { snapshotPrivateCalendarAuthority } from './authority.ts';
import { exactRecord, hexBytes, positiveInteger } from './validation.ts';

export interface PrivateCalendarCloudCacheHead {
  cacheId: string; manifestDigest: string; authorityDigest: string; sequence: number; chunkCount: number;
}
export interface PrivateCalendarCloudHead {
  schemaVersion: 1; ownerUserId: string; accountGeneration: string; rootDigest: string;
  authorityRevision: number; authorityDigest: string; authorityJson: string; keyVersion: number; mainDeviceId: string;
  deviceIds: string[]; cacheHead: PrivateCalendarCloudCacheHead | null;
}
export const PRIVATE_CALENDAR_CLOUD_HEAD_FIELDS = ['schemaVersion', 'ownerUserId', 'accountGeneration', 'rootDigest', 'authorityRevision', 'authorityDigest', 'authorityJson', 'keyVersion', 'mainDeviceId', 'deviceIds', 'cacheHead'] as const;
export class PrivateCalendarCloudConflict extends Error {
  readonly code = 'private-calendar/conflict';
  constructor() { super('本人用Calendarの設定または送信内容が更新されています。再読込して確認してください。'); this.name = 'PrivateCalendarCloudConflict'; }
}
export function privateCalendarCloudFields(authority: VerifiedPrivateCalendarAuthority, cacheHead: PrivateCalendarCloudCacheHead | null = null): PrivateCalendarCloudHead {
  const body = authority.signed.body;
  return { schemaVersion: 1, ownerUserId: body.ownerUserId, accountGeneration: body.accountGeneration, rootDigest: authority.anchor.rootDigest,
    authorityRevision: body.revision, authorityDigest: authority.digest, authorityJson: canonicalJson(authority.signed), keyVersion: body.keyVersion,
    mainDeviceId: body.mainDeviceId, deviceIds: body.devices.map((device) => device.deviceId), cacheHead: cacheHead ? { ...cacheHead } : null };
}
export function snapshotPrivateCalendarCloudCacheHead(value: PrivateCalendarCloudCacheHead): PrivateCalendarCloudCacheHead {
  exactRecord(value, ['cacheId', 'manifestDigest', 'authorityDigest', 'sequence', 'chunkCount']);
  hexBytes(value.cacheId, 32); hexBytes(value.manifestDigest, 32); hexBytes(value.authorityDigest, 32); positiveInteger(value.sequence); positiveInteger(value.chunkCount);
  if (value.chunkCount > 32) throw new Error('本人用Calendarの分割数を確認できません。'); return { ...value };
}
export function parsePrivateCalendarCloudAuthority(json: string): SignedPrivateCalendarAuthority {
  if (typeof json !== 'string' || json.length > MAX_PRIVATE_CALENDAR_AUTHORITY_DOCUMENT_BYTES) throw new Error('本人用Calendarの認証情報が大きすぎます。');
  return snapshotPrivateCalendarAuthority(JSON.parse(json));
}
/** Public metadata bounds only. The caller must verify the returned signed chain against its own protected anchor. */
export function parsePrivateCalendarCloudHead(value: PrivateCalendarCloudHead, ownerUserId: string): PrivateCalendarCloudHead {
  exactRecord(value, PRIVATE_CALENDAR_CLOUD_HEAD_FIELDS); assertSharedIdentifier(ownerUserId);
  if (value.schemaVersion !== 1 || value.ownerUserId !== ownerUserId) throw new Error('本人用Calendarの所有アカウントが異なります。');
  hexBytes(value.accountGeneration, 32); hexBytes(value.rootDigest, 32); hexBytes(value.authorityDigest, 32);
  positiveInteger(value.authorityRevision); positiveInteger(value.keyVersion); assertSharedIdentifier(value.mainDeviceId);
  if (!Array.isArray(value.deviceIds) || !value.deviceIds.length || value.deviceIds.length > 16) throw new Error('本人用Calendarの端末数が無効です。');
  value.deviceIds.forEach(assertSharedIdentifier);
  const signed = parsePrivateCalendarCloudAuthority(value.authorityJson); const body = signed.body;
  if (body.ownerUserId !== ownerUserId || body.accountGeneration !== value.accountGeneration || body.revision !== value.authorityRevision
    || body.keyVersion !== value.keyVersion || body.mainDeviceId !== value.mainDeviceId || sharedDocumentDigest(signed) !== value.authorityDigest
    || body.devices.length !== value.deviceIds.length || body.devices.some((device, index) => device.deviceId !== value.deviceIds[index])) throw new Error('本人用Calendarの公開情報と署名内容が異なります。');
  if (value.keyVersion > value.authorityRevision || value.authorityRevision === 1 && value.rootDigest !== value.authorityDigest) throw new Error('本人用Calendarの認証位置が異なります。');
  return { ...value, authorityJson: canonicalJson(signed), deviceIds: [...value.deviceIds], cacheHead: value.cacheHead === null ? null : snapshotPrivateCalendarCloudCacheHead(value.cacheHead) };
}
export function assertPrivateCalendarCloudAuthority(head: PrivateCalendarCloudHead, authority: VerifiedPrivateCalendarAuthority): void {
  if (head.ownerUserId !== authority.signed.body.ownerUserId || head.accountGeneration !== authority.anchor.accountGeneration
    || head.rootDigest !== authority.anchor.rootDigest || head.authorityDigest !== authority.digest || head.authorityRevision !== authority.signed.body.revision) throw new PrivateCalendarCloudConflict();
}
