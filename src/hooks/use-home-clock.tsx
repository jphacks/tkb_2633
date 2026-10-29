import { useEffect, useState } from 'react';
import { AppState } from 'react-native';
import { nextHomeClockDelay } from '../features/planner/home-summary';

export function useHomeClock(timeZone?: string) {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let live = true;
    const update = () => {
      clearTimeout(timer);
      if (!live || AppState.currentState === 'background' || AppState.currentState === 'inactive') return;
      const current = new Date(); setNow(current);
      timer = setTimeout(update, nextHomeClockDelay(current, timeZone));
    };
    update();
    const listener = AppState.addEventListener('change', (state) => { if (state === 'active') update(); else clearTimeout(timer); });
    return () => { live = false; clearTimeout(timer); listener.remove(); };
  }, [timeZone]);
  return now;
}
