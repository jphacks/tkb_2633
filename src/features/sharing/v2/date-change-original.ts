import { targetReferenceTime } from './date-target.ts';
import { v2RuleTargetCandidates } from './rule-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

/** Derived from observed source rules, never from the requester's assertion that its old time is missing. */
export function v2DateChangeOriginal(rules: readonly ManualRule[], occurrence: SharedOccurrence, timeZone: string) {
  const targets: DateTarget[] = []; const knownReferences: number[] = []; let unresolved = false;
  for (const rule of rules) {
    const result = v2RuleTargetCandidates(rule, occurrence, timeZone);
    if (result.kind === 'review') throw new Error('周期や地域の適用を確認してください。');
    if (result.kind === 'missingTime') { unresolved = true; knownReferences.push(...result.referenceTimes); }
    else { targets.push(...result.targets); unresolved ||= result.targets.length !== 1; }
  }
  targets.sort((a, b) => targetReferenceTime(a, timeZone) - targetReferenceTime(b, timeZone));
  const original: DateTarget | null = targets[0] ?? (rules.length ? null : { precision: 'date', date: occurrence.anchorDate });
  const references = [...knownReferences, ...targets.map((target) => targetReferenceTime(target, timeZone)), ...(original ? [targetReferenceTime(original, timeZone)] : [])];
  const originalReferenceAt = references.length ? Math.min(...references) : null;
  return { original, targets, unresolved, originalMissingTime: original === null, originalReferenceAt };
}
