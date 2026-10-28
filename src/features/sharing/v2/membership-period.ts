import type { VerifiedSharedRoster } from '../roster';

interface Period { from: number; until: number }
const indexes = new WeakMap<readonly VerifiedSharedRoster[], { head: VerifiedSharedRoster | undefined; length: number; periods: Map<string, Period[]> }>();

/** Verified archives are append-only. A new device or key does not end an existing user's membership. */
export function v2MembershipStart(archive: readonly VerifiedSharedRoster[], userId: string, keyVersion: number): number | null {
  const head = archive.at(-1);
  if (!head || !Number.isSafeInteger(keyVersion) || keyVersion < 1 || keyVersion > head.body.keyVersion) return null;
  let index = indexes.get(archive);
  if (!index || index.head !== head || index.length !== archive.length) {
    const periods = new Map<string, Period[]>(); let previous = new Set<string>();
    for (const epoch of archive) {
      const active = new Set(epoch.body.members.map(member => member.userId));
      for (const uid of previous) if (!active.has(uid)) periods.get(uid)!.at(-1)!.until = epoch.body.keyVersion;
      for (const uid of active) if (!previous.has(uid)) {
        const entries = periods.get(uid) ?? []; entries.push({ from: epoch.body.keyVersion, until: Infinity }); periods.set(uid, entries);
      }
      previous = active;
    }
    index = { head, length: archive.length, periods }; indexes.set(archive, index);
  }
  const periods = index.periods.get(userId) ?? []; let low = 0; let high = periods.length - 1;
  while (low <= high) {
    const middle = (low + high) >>> 1; const period = periods[middle];
    if (keyVersion < period.from) high = middle - 1;
    else if (keyVersion >= period.until) low = middle + 1;
    else return period.from;
  }
  return null;
}
