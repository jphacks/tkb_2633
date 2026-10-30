import { assertJsonRecord } from '../operations.ts';

/** Take ownership of a command before an await. Optional values keep their original meaning. */
export function captureV2Input<T>(value: T, depth = 0): T {
  if (depth > 32) throw new Error('操作内容が深すぎます。内容を確認してください。');
  if (value === undefined || value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('操作の数値を確認してください。');
    return value;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw new Error('一度に扱う操作内容が多すぎます。');
    return value.map(item => captureV2Input(item, depth + 1)) as T;
  }
  assertJsonRecord(value);
  const entries = Object.entries(value);
  if (entries.length > 512) throw new Error('操作の項目が多すぎます。');
  return Object.fromEntries(entries.map(([key, item]) => [key, captureV2Input(item, depth + 1)])) as T;
}
