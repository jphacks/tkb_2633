import { canonicalJson } from '../operations.ts';
import type { SignedPrivateCalendarAuthority } from './authority';

export const MAX_PRIVATE_CALENDAR_AUTHORITIES = 4096;
export const MAX_PRIVATE_CALENDAR_AUTHORITY_HISTORY_BYTES = 4 * 1024 * 1024;
export const MAX_PRIVATE_CALENDAR_AUTHORITY_DOCUMENT_BYTES = 16_000;

/** Do not publish a valid individual update that makes the complete pinned chain unreadable. */
export function assertPrivateCalendarAuthorityAppend(history: readonly SignedPrivateCalendarAuthority[], next: SignedPrivateCalendarAuthority) {
  const bytes = history.reduce((sum, signed) => sum + canonicalJson(signed).length, canonicalJson(next).length);
  if (history.length + 1 > MAX_PRIVATE_CALENDAR_AUTHORITIES || bytes > MAX_PRIVATE_CALENDAR_AUTHORITY_HISTORY_BYTES) throw new Error('本人端末の署名履歴が上限に達しています。保存済みの設定を保持して、新しい変更の送信を止めています。');
}
