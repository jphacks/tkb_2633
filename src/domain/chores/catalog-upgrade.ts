import type { ChoreDefinition, ChoreLoad, FrequencyMode } from './types.ts';

type ScheduleDefaults = Pick<ChoreDefinition,
  'load' | 'frequencyDaysByMode' | 'windowRadiusDays' | 'maxShiftDays' | 'holidayPriority' | 'everyday'>;

// Frozen version 1/2 defaults, used only to recognize untouched settings during the version 3 upgrade.
// Current catalog defaults must always be specified on each entry in catalog.ts.
const PREVIOUS_CYCLES: Record<ChoreLoad, ChoreDefinition['frequencyDaysByMode']> = {
  heavy: { frequent: 14, balanced: 30, relaxed: 60 },
  normal: { frequent: 7, balanced: 14, relaxed: 30 },
  light: { frequent: 3, balanced: 7, relaxed: 14 },
};

const PREVIOUS_LOADS: Readonly<Record<string, ChoreLoad>> = {
  'builtin-chore-01': 'heavy',
  'builtin-chore-02': 'heavy',
  'builtin-chore-03': 'heavy',
  'builtin-chore-04': 'heavy',
  'builtin-chore-05': 'heavy',
  'builtin-chore-06': 'normal',
  'builtin-chore-07': 'normal',
  'builtin-chore-08': 'normal',
  'builtin-chore-09': 'normal',
  'builtin-chore-10': 'normal',
  'builtin-chore-11': 'light',
  'builtin-chore-12': 'light',
  'builtin-chore-13': 'light',
  'builtin-chore-14': 'light',
  'builtin-chore-15': 'light',
  'builtin-chore-16': 'light',
  'builtin-chore-17': 'normal',
  'builtin-chore-18': 'normal',
  'builtin-chore-19': 'light',
  'builtin-chore-20': 'normal',
};

function previousDefaults(id: string): ScheduleDefaults | undefined {
  const load = PREVIOUS_LOADS[id];
  if (!load) return undefined;
  const everyday = id === 'builtin-chore-11';
  return {
    load,
    frequencyDaysByMode: everyday ? { frequent: 1, balanced: 1, relaxed: 2 } : PREVIOUS_CYCLES[load],
    windowRadiusDays: load === 'heavy' ? 2 : load === 'light' ? 0 : 1,
    maxShiftDays: everyday ? 0 : load === 'heavy' ? 7 : 4,
    holidayPriority: load === 'heavy',
    everyday,
  };
}

/** Upgrade each unchanged default independently, preserving all explicit interval overrides and other user data. */
export function upgradeBuiltInScheduleDefaults(
  existing: ChoreDefinition,
  current: ChoreDefinition,
): { definition: ChoreDefinition; scheduleChanged: boolean } {
  const previous = previousDefaults(existing.id);
  if (!previous || existing.id !== current.id) return { definition: existing, scheduleChanged: false };

  const upgradeMode = (mode: FrequencyMode) => existing.frequencyDaysByMode[mode] === previous.frequencyDaysByMode[mode]
    ? current.frequencyDaysByMode[mode]
    : existing.frequencyDaysByMode[mode];
  const definition: ChoreDefinition = {
    ...existing,
    frequencyDaysByMode: { frequent: upgradeMode('frequent'), balanced: upgradeMode('balanced'), relaxed: upgradeMode('relaxed') },
    load: existing.load === previous.load ? current.load : existing.load,
    windowRadiusDays: existing.windowRadiusDays === previous.windowRadiusDays ? current.windowRadiusDays : existing.windowRadiusDays,
    maxShiftDays: existing.maxShiftDays === previous.maxShiftDays ? current.maxShiftDays : existing.maxShiftDays,
    holidayPriority: existing.holidayPriority === previous.holidayPriority ? current.holidayPriority : existing.holidayPriority,
    everyday: existing.everyday === previous.everyday ? current.everyday : existing.everyday,
  };
  const scheduleChanged = definition.load !== existing.load
    || definition.windowRadiusDays !== existing.windowRadiusDays
    || definition.maxShiftDays !== existing.maxShiftDays
    || definition.holidayPriority !== existing.holidayPriority
    || definition.everyday !== existing.everyday
    || (['frequent', 'balanced', 'relaxed'] as const).some((mode) => definition.frequencyDaysByMode[mode] !== existing.frequencyDaysByMode[mode]);
  return { definition, scheduleChanged };
}
