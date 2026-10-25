import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFocusEffect } from 'expo-router';
import { AppState } from 'react-native';

import type { ChoreDefinition, FrequencyMode } from '@/domain/chores/types';
import type { ChoreSettingsPatch } from '@/domain/chores/settings-patch';
import { parseSettingInteger } from '@/domain/chores/settings-patch';
import { createAutosaveQueue } from './autosave-queue';

export function useChoreSettingsAutosave(chore: ChoreDefinition, mode: FrequencyMode, savePatch: (patch: ChoreSettingsPatch) => Promise<void>) {
  const [draft, setDraft] = useState(() => ({
    cycleText: chore.requiresCycleSelection ? '' : String(chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode]),
    radiusText: String(chore.windowRadiusDays), load: chore.load, enabled: chore.enabled,
    holidayPriority: chore.holidayPriority, dryingPreference: chore.laundryDryingPreference ?? 'either',
  }));
  const latest = useRef(draft);
  const enabledTouched = useRef(false);
  const leaving = useRef(false);
  const [queue] = useState(() => createAutosaveQueue<ChoreSettingsPatch>({ save: savePatch }));
  const status = useSyncExternalStore(queue.subscribe, queue.getSnapshot, queue.getSnapshot);
  const updateDraft = (patch: Partial<typeof draft>) => {
    latest.current = { ...latest.current, ...patch };
    setDraft(latest.current);
  };

  useFocusEffect(useCallback(() => {
    leaving.current = false;
    return () => { void queue.flush(); };
  }, [queue]));
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => {
      if (state !== 'active') void queue.flush();
    });
    return () => { subscription.remove(); void queue.flush(); };
  }, [queue]);

  const changeCycle = (text: string) => {
    const value = parseSettingInteger(text, 1, 3650);
    const autoEnable = value !== undefined && chore.requiresCycleSelection && !enabledTouched.current;
    updateDraft({ cycleText: text, ...(autoEnable ? { enabled: true } : {}) });
    if (value !== undefined) queue.enqueue({ cycleDays: value, ...(autoEnable ? { enabled: true } : {}) });
    else {
      queue.remove('cycleDays');
      if (!enabledTouched.current && chore.requiresCycleSelection) { queue.remove('enabled'); updateDraft({ enabled: false }); }
    }
  };
  const changeRadius = (text: string) => {
    updateDraft({ radiusText: text });
    const value = parseSettingInteger(text, 0, 14);
    if (value !== undefined) queue.enqueue({ windowRadiusDays: value });
    else queue.remove('windowRadiusDays');
  };
  const resetCycle = () => {
    const missingManufacturerCycle = Boolean(chore.applianceCareSource && chore.manufacturerRecommendedIntervalDays === undefined);
    updateDraft({ cycleText: missingManufacturerCycle ? '' : String(chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode]),
      ...(missingManufacturerCycle ? { enabled: false } : {}) });
    queue.enqueue({ cycleDays: null, ...(missingManufacturerCycle ? { enabled: false } : {}) }, true);
  };
  const flush = () => {
    // Finishing an empty cycle restores the default; unknown appliance cycles become unscheduled.
    if (!latest.current.cycleText.trim()) resetCycle();
    return queue.flush();
  };
  return {
    draft, status, changeCycle, changeRadius, resetCycle, flush,
    async navigateAfterSave(navigate: () => void) {
      if (leaving.current) return;
      leaving.current = true;
      if (await flush()) navigate();
      else leaving.current = false;
    },
    cycleError: draft.cycleText.trim() && parseSettingInteger(draft.cycleText, 1, 3650) === undefined
      ? '周期は1〜3650日の整数で入力してください。' : null,
    radiusError: parseSettingInteger(draft.radiusText, 0, 14) === undefined ? '期間幅は±0〜±14日の整数で入力してください。' : null,
    changeEnabled(value: boolean) { enabledTouched.current = true; updateDraft({ enabled: value }); queue.enqueue({ enabled: value }, true); },
    changeLoad(value: typeof draft.load) { updateDraft({ load: value }); queue.enqueue({ load: value }, true); },
    changeHoliday(value: boolean) { updateDraft({ holidayPriority: value }); queue.enqueue({ holidayPriority: value }, true); },
    changeDrying(value: typeof draft.dryingPreference) { updateDraft({ dryingPreference: value }); queue.enqueue({ laundryDryingPreference: value }, true); },
  };
}
