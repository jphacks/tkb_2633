import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
} from '@/domain/chores/types';
import type { EntityId, LocalDate } from '@/domain/shared/types';
import type { ScheduleSettings } from '@/domain/scheduling/contracts';
import { addDays, daysBetween, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { DailyWeather, WeatherAdjustmentPolicy, WeatherScheduleAdjustment } from './contracts';

export const LAUNDRY_WEATHER_RULES = Object.freeze({
  forecastDays: 7,
  maxPrecipitationProbability: 30,
  maxPrecipitationMm: 0.5,
  suitableWeatherCodes: [0, 1, 2, 3] as readonly number[],
});

export interface LaundryWeatherAdjustmentData {
  suggestedDate: LocalDate;
  windowStart: LocalDate;
  windowEnd: LocalDate;
  status: ChoreScheduleEntry['status'];
}

export interface LaundryWeatherPolicyContext {
  today: LocalDate;
  chores: readonly ChoreDefinition[];
  completions: readonly ChoreCompletion[];
  dependencies: readonly ChoreDependency[];
  settings: ScheduleSettings;
}

interface DayLoad {
  heavy: number;
  normal: number;
  total: number;
}

/** Pure policy that only proposes date changes for eligible laundry entries. */
export class LaundryWeatherAdjustmentPolicy implements WeatherAdjustmentPolicy<
  readonly DailyWeather[],
  LaundryWeatherAdjustmentData
> {
  private readonly context: LaundryWeatherPolicyContext;

  constructor(context: LaundryWeatherPolicyContext) {
    this.context = context;
  }

  proposeAdjustments(input: {
    forecast: readonly DailyWeather[];
    schedule: readonly ChoreScheduleEntry[];
  }): readonly WeatherScheduleAdjustment<LaundryWeatherAdjustmentData>[] {
    const forecastByDate = new Map(input.forecast.map((day) => [day.date, day]));
    const forecastThrough = addDays(this.context.today, LAUNDRY_WEATHER_RULES.forecastDays - 1);
    const choresById = new Map(this.context.chores.map((chore) => [chore.id, chore]));
    const completedScheduleIds = new Set(this.context.completions
      .filter((completion) => completion.outcome === 'completed' && completion.scheduleEntryId)
      .map((completion) => completion.scheduleEntryId));
    const workingSchedule = input.schedule.map((entry) => ({ ...entry, assignedMemberIds: [...entry.assignedMemberIds] }));
    const loads = createDayLoads(workingSchedule, choresById);
    const entriesByChore = indexEntriesByChore(workingSchedule);
    const adjustments: WeatherScheduleAdjustment<LaundryWeatherAdjustmentData>[] = [];

    const targets = [...workingSchedule]
      .filter((entry) => {
        const chore = choresById.get(entry.choreId);
        return chore !== undefined
          && isLaundryChore(chore)
          && chore.laundryDryingPreference !== 'indoors'
          && entry.status !== 'initialPending'
          && !completedScheduleIds.has(entry.id)
          && entry.suggestedDate >= this.context.today
          && entry.suggestedDate <= forecastThrough;
      })
      .sort((left, right) => left.suggestedDate.localeCompare(right.suggestedDate) || left.id.localeCompare(right.id));

    for (const target of targets) {
      const currentIndex = workingSchedule.findIndex((entry) => entry.id === target.id);
      if (currentIndex < 0) continue;
      const current = workingSchedule[currentIndex];
      const chore = choresById.get(current.choreId);
      if (!chore || isSuitableLaundryDay(forecastByDate.get(current.suggestedDate))) continue;

      const radius = Math.max(0, Math.trunc(chore.windowRadiusDays));
      const maxShift = Math.max(0, Math.trunc(chore.maxShiftDays));
      const minimumDate = laterDate(this.context.today, addDays(current.cycleBaseDate, -maxShift - radius));
      const maximumDate = earlierDate(forecastThrough, addDays(current.cycleBaseDate, maxShift + radius));
      const originalDate = current.suggestedDate;

      removeLoad(loads, chore, originalDate);
      const candidates: LocalDate[] = [];
      for (let date = minimumDate; date <= maximumDate; date = addDays(date, 1)) {
        if (!isSuitableLaundryDay(forecastByDate.get(date))) continue;
        if (!fitsLoadLimits(loads.get(date), chore, this.context.settings)) continue;
        if (!respectsDependencies(date, current, this.context.dependencies, entriesByChore)) continue;
        candidates.push(date);
      }

      candidates.sort((left, right) => {
        const distanceDifference = Math.abs(daysBetween(originalDate, left)) - Math.abs(daysBetween(originalDate, right));
        if (distanceDifference !== 0) return distanceDifference;
        if (chore.holidayPriority) {
          const leftRestDay = this.context.settings.restDays.includes(weekdayOf(left)) ? 0 : 1;
          const rightRestDay = this.context.settings.restDays.includes(weekdayOf(right)) ? 0 : 1;
          if (leftRestDay !== rightRestDay) return leftRestDay - rightRestDay;
        }
        const loadDifference = (loads.get(left)?.total ?? 0) - (loads.get(right)?.total ?? 0);
        return loadDifference || left.localeCompare(right);
      });

      const suggestedDate = candidates[0];
      if (!suggestedDate || suggestedDate === originalDate) {
        addLoad(loads, chore, originalDate);
        continue;
      }

      const windowStart = minimumDate;
      const windowEnd = addDays(current.cycleBaseDate, maxShift + radius);
      const status: ChoreScheduleEntry['status'] = current.status === 'overdue'
        ? 'overdue'
        : this.context.today >= windowStart && this.context.today <= windowEnd
          ? 'inWindow'
          : 'scheduled';
      const adjusted = { ...current, suggestedDate, windowStart, windowEnd, status };
      workingSchedule[currentIndex] = adjusted;
      replaceIndexedEntry(entriesByChore, adjusted);
      addLoad(loads, chore, suggestedDate);
      adjustments.push({ scheduleEntryId: current.id, data: { suggestedDate, windowStart, windowEnd, status } });
    }
    return adjustments;
  }
}

export function isLaundryChore(chore: ChoreDefinition): boolean {
  return chore.category.trim().toLocaleLowerCase() === '洗濯'
    || chore.laundryDryingPreference !== undefined;
}

export function isSuitableLaundryDay(day: DailyWeather | undefined): boolean {
  return day !== undefined
    && day.weatherCode !== null
    && LAUNDRY_WEATHER_RULES.suitableWeatherCodes.includes(day.weatherCode)
    && day.precipitationProbability !== null
    && day.precipitationProbability <= LAUNDRY_WEATHER_RULES.maxPrecipitationProbability
    && day.precipitationMm !== null
    && day.precipitationMm <= LAUNDRY_WEATHER_RULES.maxPrecipitationMm;
}

export function applyLaundryWeatherAdjustments(
  schedule: readonly ChoreScheduleEntry[],
  adjustments: readonly WeatherScheduleAdjustment<LaundryWeatherAdjustmentData>[],
): ChoreScheduleEntry[] {
  const byId = new Map(adjustments.map((adjustment) => [adjustment.scheduleEntryId, adjustment.data]));
  return schedule.map((entry) => {
    const data = byId.get(entry.id);
    return data ? { ...entry, ...data, assignedMemberIds: [...entry.assignedMemberIds] } : entry;
  }).sort((left, right) =>
    left.suggestedDate.localeCompare(right.suggestedDate) || left.choreId.localeCompare(right.choreId),
  );
}

function createDayLoads(
  schedule: readonly ChoreScheduleEntry[],
  choresById: ReadonlyMap<EntityId, ChoreDefinition>,
): Map<LocalDate, DayLoad> {
  const loads = new Map<LocalDate, DayLoad>();
  for (const entry of schedule) {
    const chore = choresById.get(entry.choreId);
    if (chore) addLoad(loads, chore, entry.suggestedDate);
  }
  return loads;
}

function addLoad(loads: Map<LocalDate, DayLoad>, chore: ChoreDefinition, date: LocalDate): void {
  const load = { ...(loads.get(date) ?? { heavy: 0, normal: 0, total: 0 }) };
  if (chore.load === 'heavy') load.heavy += 1;
  if (chore.load === 'normal') load.normal += 1;
  load.total += 1;
  loads.set(date, load);
}

function removeLoad(loads: Map<LocalDate, DayLoad>, chore: ChoreDefinition, date: LocalDate): void {
  const load = loads.get(date);
  if (!load) return;
  if (chore.load === 'heavy') load.heavy = Math.max(0, load.heavy - 1);
  if (chore.load === 'normal') load.normal = Math.max(0, load.normal - 1);
  load.total = Math.max(0, load.total - 1);
  if (load.total === 0) loads.delete(date);
}

function fitsLoadLimits(load: DayLoad | undefined, chore: ChoreDefinition, settings: ScheduleSettings): boolean {
  if (!load) return true;
  if (chore.load === 'heavy') return load.heavy + 1 <= settings.loadLimits.heavyDailyLimit;
  if (chore.load === 'normal') return load.normal + 1 <= settings.loadLimits.normalDailyLimit;
  return true;
}

function indexEntriesByChore(schedule: readonly ChoreScheduleEntry[]): Map<EntityId, ChoreScheduleEntry[]> {
  const entries = new Map<EntityId, ChoreScheduleEntry[]>();
  for (const entry of schedule) entries.set(entry.choreId, [...(entries.get(entry.choreId) ?? []), entry]);
  for (const values of entries.values()) {
    values.sort((left, right) => left.cycleBaseDate.localeCompare(right.cycleBaseDate) || left.id.localeCompare(right.id));
  }
  return entries;
}

function replaceIndexedEntry(entriesByChore: Map<EntityId, ChoreScheduleEntry[]>, updated: ChoreScheduleEntry): void {
  const entries = entriesByChore.get(updated.choreId);
  if (!entries) return;
  const index = entries.findIndex((entry) => entry.id === updated.id);
  if (index >= 0) entries[index] = updated;
}

function respectsDependencies(
  candidate: LocalDate,
  current: ChoreScheduleEntry,
  dependencies: readonly ChoreDependency[],
  entriesByChore: ReadonlyMap<EntityId, readonly ChoreScheduleEntry[]>,
): boolean {
  const ownEntries = entriesByChore.get(current.choreId) ?? [];
  const occurrence = ownEntries.findIndex((entry) => entry.id === current.id);
  if (occurrence < 0) return true;

  for (const dependency of dependencies) {
    if (dependency.successorChoreId === current.choreId) {
      const predecessors = entriesByChore.get(dependency.predecessorChoreId) ?? [];
      const predecessor = predecessors[Math.min(occurrence, predecessors.length - 1)];
      if (predecessor && candidate < predecessor.suggestedDate) return false;
    }
    if (dependency.predecessorChoreId === current.choreId) {
      const successors = entriesByChore.get(dependency.successorChoreId) ?? [];
      const successor = successors[Math.min(occurrence, successors.length - 1)];
      if (successor && candidate > successor.suggestedDate) return false;
    }
  }
  return true;
}

function laterDate(left: LocalDate, right: LocalDate): LocalDate {
  return left > right ? left : right;
}

function earlierDate(left: LocalDate, right: LocalDate): LocalDate {
  return left < right ? left : right;
}
