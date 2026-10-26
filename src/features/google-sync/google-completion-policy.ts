/** Validate Google's explicit completion timestamp; updated/due are never substitutes. */
export function parseGoogleCompletedAt(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/u.exec(value);
  if (!parts) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = parts;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const monthDays = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (month < 1 || month > 12 || day < 1 || day > monthDays[month - 1]
    || Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText) > 59) return null;
  const instant = Date.parse(value);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/** A network response may not undo a local edit that happened while the request was running. */
export function googleTaskImportAction(link: { pendingStatus?: string | null; lastSyncedStatus?: string | null },
  currentOutcome: string | undefined, remoteStatus: 'completed' | 'needsAction'): 'complete' | 'undo' | 'ignore' {
  if (link.pendingStatus) return 'ignore';
  const localStatus = currentOutcome === 'completed' ? 'completed' : 'needsAction';
  if (link.lastSyncedStatus && localStatus !== link.lastSyncedStatus) return 'ignore';
  if (!link.lastSyncedStatus && currentOutcome === 'incomplete') return 'ignore';
  if (remoteStatus === 'completed' && localStatus !== 'completed') return 'complete';
  if (remoteStatus === 'needsAction' && link.lastSyncedStatus === 'completed' && currentOutcome === 'completed') return 'undo';
  return 'ignore';
}
