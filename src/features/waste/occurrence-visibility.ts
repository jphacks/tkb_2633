import type { WasteCollectionOccurrence } from './contracts';

export function wasteOccurrenceKey(occurrence: Pick<WasteCollectionOccurrence, 'scheduleId' | 'date'>): string {
  return `${occurrence.scheduleId}:${occurrence.date}`;
}

export function splitWasteOccurrencesByVisibility(
  occurrences: readonly WasteCollectionOccurrence[],
  hiddenKeys: ReadonlySet<string>,
): { visible: WasteCollectionOccurrence[]; hidden: WasteCollectionOccurrence[] } {
  const visible: WasteCollectionOccurrence[] = [];
  const hidden: WasteCollectionOccurrence[] = [];
  for (const occurrence of occurrences) {
    (hiddenKeys.has(wasteOccurrenceKey(occurrence)) ? hidden : visible).push(occurrence);
  }
  return { visible, hidden };
}
