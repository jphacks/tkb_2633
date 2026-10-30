import { hexToBytes } from '@noble/hashes/utils.js';
import { assertJsonRecord } from '../operations.ts';

/** These contracts are account scoped and must never be accepted as group operations. */
export function exactRecord(value: unknown, fields: readonly string[]): asserts value is Record<string, unknown> {
  assertJsonRecord(value);
  if (Object.keys(value).sort().join(',') !== [...fields].sort().join(',')) throw new Error('本人用Calendarの形式を確認できません。');
}
export function positiveInteger(value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) throw new Error('本人用Calendarの世代・連番が無効です。');
}
export function hexBytes(value: unknown, length: number): Uint8Array {
  if (typeof value !== 'string' || value.length !== length * 2 || !/^[0-9a-f]+$/u.test(value)) throw new Error('本人用Calendarの暗号形式が無効です。');
  return hexToBytes(value);
}
