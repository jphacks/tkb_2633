import { targetReferenceTime } from './date-target.ts';
import { v2RuleTargetCandidates } from './rule-target.ts';
import type { DateTarget, ManualRule, SharedOccurrence } from './model.ts';

/** Derived from observed source rules, never from the requester's assertion that its old time is missing. */
export function v2DateChangeOriginal(rules: readonly ManualRule[], occurrence: SharedOccurrence, timeZone: string) {
  const entries: { target: DateTarget; referenceAt: number; timeZone: string }[] = []; const knownReferences: number[] = []; let unresolved = false;
  for (const rule of rules) {
    const result = v2RuleTargetCandidates(rule, occurrence, timeZone);
    if (result.kind === 'review') throw new Error('周期や地域の適用を確認してください。');
    if (result.kind === 'missingTime') { unresolved = true; knownReferences.push(...result.referenceTimes); }
    else { entries.push(...result.targets.map((target) => ({ target, referenceAt: targetReferenceTime(target, rule.timeZoneAtCreation), timeZone: rule.timeZoneAtCreation }))); unresolved ||= result.targets.length !== 1; }
  }
  entries.sort((a, b) => a.referenceAt - b.referenceAt);
  const targets = entries.map((entry) => entry.target);
  const original: DateTarget | null = targets[0] ?? (rules.length ? null : { precision: 'date', date: occurrence.anchorDate });
  const references = [...knownReferences, ...entries.map((entry) => entry.referenceAt), ...(!rules.length && original ? [targetReferenceTime(original, timeZone)] : [])];
  const originalReferenceAt = references.length ? Math.min(...references) : null;
  return { original, targets, unresolved, originalMissingTime: original === null, originalReferenceAt, originalTimeZone: entries[0]?.timeZone ?? timeZone,
    latestOriginalReferenceAt: references.length ? Math.max(...references) : null };
}
