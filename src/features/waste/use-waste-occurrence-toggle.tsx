import { useRef, useState } from 'react';
import type { SQLiteDatabase } from 'expo-sqlite';

import type { WasteCollectionOccurrence } from './contracts';
import { setWasteOccurrenceHidden } from '@/platform/storage/repository';

/** Shared persistence for home and calendar; a check only affects this collection date. */
export function useWasteOccurrenceToggle(database: SQLiteDatabase, refresh: () => Promise<unknown>) {
  const inFlight = useRef(new Set<string>());
  const [busyKeys, setBusyKeys] = useState<ReadonlySet<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const toggle = async (occurrence: WasteCollectionOccurrence, hidden: boolean) => {
    const key = `${occurrence.scheduleId}:${occurrence.date}`;
    if (inFlight.current.has(key)) return;
    inFlight.current.add(key);
    setBusyKeys(new Set(inFlight.current));
    setError(null);
    try {
      await setWasteOccurrenceHidden(database, occurrence.scheduleId, occurrence.date, !hidden);
      await refresh();
    } catch {
      setError('ゴミ出しの表示を保存できませんでした。もう一度お試しください。');
    } finally {
      inFlight.current.delete(key);
      setBusyKeys(new Set(inFlight.current));
    }
  };
  return { toggle, busyKeys, error };
}
