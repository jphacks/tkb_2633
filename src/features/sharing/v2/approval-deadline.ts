import { targetReferenceTime } from './date-target.ts';
import type { DateTarget } from './model.ts';

const hour = 3600_000;
export type ApprovalDeadline = { kind: 'pendingDelivery' } | { kind: 'tooLate'; referenceAt: number }
  | { kind: 'open'; referenceAt: number; requestedAt: number; expiresAt: number; graceHours: number };

/** requestedAt is an immutable server receipt, never an untrusted device timestamp. */
export function approvalDeadline(input: { serverRequestedAt: number | null; original: DateTarget | null; originalReferenceAt?: number | null;
  proposed: DateTarget; proposedReferenceAt?: number | null; timeZone: string }): ApprovalDeadline {
  const proposedAt = input.proposedReferenceAt ?? targetReferenceTime(input.proposed, input.timeZone);
  if (!Number.isSafeInteger(proposedAt)) throw new Error('変更先の指定から検証した時刻を確認してください。');
  const verifiedStart = input.originalReferenceAt ?? null;
  if (verifiedStart !== null && !Number.isSafeInteger(verifiedStart)) throw new Error('元の指定から検証した開始時刻を確認してください。');
  // The receiver derives this from every authenticated source in its original region (including known DST starts).
  const originalAt = verifiedStart ?? (input.original === null ? null : targetReferenceTime(input.original, input.timeZone));
  const referenceAt = originalAt === null ? proposedAt : Math.min(originalAt, proposedAt);
  if (input.serverRequestedAt === null) return { kind: 'pendingDelivery' };
  const requestedAt = input.serverRequestedAt;
  if (!Number.isSafeInteger(requestedAt)) throw new Error('申請のサーバー受付時刻を確認できません。');
  const remaining = referenceAt - requestedAt;
  if (remaining <= hour) return { kind: 'tooLate', referenceAt };
  const graceHours = remaining > 36 * hour ? 24 : remaining > 24 * hour ? 12 : remaining > 12 * hour ? 6 : remaining > 6 * hour ? 3 : 1;
  return { kind: 'open', referenceAt, requestedAt, expiresAt: Math.min(requestedAt + graceHours * hour, referenceAt - hour), graceHours };
}
export function approvalDeliveryState(deadline: ApprovalDeadline, serverDecisionAt: number | null, now: number): 'pendingDelivery' | 'awaiting' | 'accepted' | 'expired' | 'tooLate' {
  if (!Number.isFinite(now)) throw new Error('現在時刻を確認してください。');
  if (deadline.kind !== 'open') return deadline.kind;
  if (serverDecisionAt === null) return now > deadline.expiresAt ? 'expired' : 'awaiting';
  if (!Number.isSafeInteger(serverDecisionAt) || serverDecisionAt < deadline.requestedAt) throw new Error('回答のサーバー受付時刻を確認できません。');
  return serverDecisionAt > deadline.expiresAt ? 'expired' : 'accepted';
}
