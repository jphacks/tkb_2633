import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';
import { assertSharedIdentifier } from '../identifier.ts';

export function privateCalendarDatabaseFilename(userId: string, development = false): string {
  assertSharedIdentifier(userId);
  if (typeof development !== 'boolean') throw new Error('本人用の保存先が無効です。');
  const digest = bytesToHex(sha256(new TextEncoder().encode(JSON.stringify(['liflow-private-calendar-db-v1', userId]))));
  return `private-calendar-${development ? 'development-' : ''}${digest}.db`;
}
