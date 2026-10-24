import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
} from '@/domain/chores/types';
import type { ScheduleGenerationInput } from '@/domain/scheduling/contracts';
import type { EntityId, LocalDate, Weekday } from '@/domain/shared/types';
import { addDays, daysBetween, localDateFromISODateTime, weekdayOf } from './local-date.ts';

interface DayLoad {
  heavy: number;
  normal: number;
  total: number;
}

interface Candidate {
  windowStart: LocalDate;
  windowEnd: LocalDate;
  suggestedDate: LocalDate;
  score: number[];
}

const ZERO_LOAD: DayLoad = { heavy: 0, normal: 0, total: 0 };

/** Shared rule-based scheduler for regular and first-run housework. */
export function generateHouseworkSchedule(input: ScheduleGenerationInput): ChoreScheduleEntry[] {
  if (daysBetween(input.from, input.through) < 0) {
    throw new RangeError('from must be on or before through');
  }

  const enabledChores = input.chores.filter((chore) => chore.enabled);
  const choresById = new Map(enabledChores.map((chore) => [chore.id, chore]));
  const orderedChores = topologicalOrder(enabledChores, input.dependencies);
  const stateByChore = new Map(input.states.map((state) => [state.choreId, state]));
  const assignmentByChore = new Map(input.assignments.map((assignment) => [assignment.choreId, assignment.memberIds]));
  const lastCompletionByChore = latestCompletionDates(input.completions);
  const loadByDate = new Map<LocalDate, DayLoad>();
  const entriesByChore = new Map<EntityId, ChoreScheduleEntry[]>();
  const entries: ChoreScheduleEntry[] = [];

  for (const chore of orderedChores) {
    const state = stateByChore.get(chore.id);
    const stateDate = state?.lastCompletedDate;
    const completionDate = lastCompletionByChore.get(chore.id);
    const lastCompleted = stateDate ?? completionDate;
    const assignment = [...(assignmentByChore.get(chore.id) ?? [])];
    const cycleDays = effectiveCycleDays(chore, input.settings.frequencyMode);
    const radius = Math.max(0, chore.windowRadiusDays ?? (cycleDays < 30 ? 1 : 2));
    const maxShift = Math.max(0, chore.maxShiftDays ?? (cycleDays < 30 ? 4 : 7));
    const choreEntries: ChoreScheduleEntry[] = [];

    if (state?.initialPending && state.initialScheduledDate) {
      const initialDate = state.initialScheduledDate;
      let overdueCycles = input.today > initialDate ? 1 : 0;
      let firstBaseDate = addDays(initialDate, cycleDays);
      while (input.today > addDays(firstBaseDate, radius)) {
        overdueCycles += 1;
        firstBaseDate = addDays(firstBaseDate, cycleDays);
      }

      if (overdueCycles > 0) {
        choreEntries.push(createOverdueEntry({
          chore,
          entryId: `${chore.id}:initial`,
          originalBaseDate: initialDate,
          overdueDays: Math.max(1, daysBetween(initialDate, input.today)),
          overdueCycles,
          assignedMemberIds: assignment,
          input,
          loadByDate,
        }));
      } else {
        choreEntries.push({
          id: `${chore.id}:initial`,
          householdId: input.householdId,
          choreId: chore.id,
          cycleBaseDate: initialDate,
          windowStart: initialDate,
          windowEnd: initialDate,
          suggestedDate: initialDate,
          status: 'initialPending',
          assignedMemberIds: assignment,
        });
      }
      appendRecurringEntries({
        chore,
        cycleDays,
        radius,
        maxShift,
        firstBaseDate,
        firstOccurrence: 1,
        assignment,
        input,
        entriesByChore,
        loadByDate,
        choreEntries,
      });
    } else if (state?.initialPending || !lastCompleted) {
      const dependencyDate = latestDependencyDate(chore.id, input.dependencies, entriesByChore, 0);
      const candidate = findCandidate({
        chore,
        baseDate: input.from,
        radius: 0,
        maxShift: daysBetween(input.from, input.through),
        minDate: dependencyDate && dependencyDate > input.from ? dependencyDate : input.from,
        from: input.from,
        through: input.through,
        restDays: input.settings.restDays,
        loadByDate,
        limits: input.settings.loadLimits,
      });
      if (candidate) {
        reserveLoad(chore, candidate.suggestedDate, loadByDate);
        choreEntries.push({
          id: `${chore.id}:initial`,
          householdId: input.householdId,
          choreId: chore.id,
          cycleBaseDate: candidate.suggestedDate,
          windowStart: candidate.windowStart,
          windowEnd: candidate.windowEnd,
          suggestedDate: candidate.suggestedDate,
          status: 'initialPending',
          assignedMemberIds: assignment,
        });

        appendRecurringEntries({
          chore,
          cycleDays,
          radius,
          maxShift,
          firstBaseDate: addDays(candidate.suggestedDate, cycleDays),
          firstOccurrence: 1,
          assignment,
          input,
          entriesByChore,
          loadByDate,
          choreEntries,
        });
      }
    } else {
      const firstBaseDate = addDays(lastCompleted, cycleDays);
      let firstUnexpiredBase = firstBaseDate;
      let expiredPeriods = 0;
      while (addDays(firstUnexpiredBase, radius) < input.from) {
        expiredPeriods += 1;
        firstUnexpiredBase = addDays(firstUnexpiredBase, cycleDays);
        if (expiredPeriods > 1000) {
          throw new RangeError(`Could not advance overdue cycle for chore ${chore.id}`);
        }
      }

      if (expiredPeriods > 0) {
        const overdueEnd = addDays(firstBaseDate, radius);
        choreEntries.push(createOverdueEntry({
          chore,
          entryId: `${chore.id}:${firstBaseDate}`,
          originalBaseDate: firstBaseDate,
          overdueDays: Math.max(1, daysBetween(overdueEnd, input.today)),
          overdueCycles: expiredPeriods,
          assignedMemberIds: assignment,
          input,
          loadByDate,
        }));
      }

      appendRecurringEntries({
        chore,
        cycleDays,
        radius,
        maxShift,
        firstBaseDate: firstUnexpiredBase,
        firstOccurrence: 1,
        assignment,
        input,
        entriesByChore,
        loadByDate,
        choreEntries,
      });
    }

    entriesByChore.set(chore.id, choreEntries);
    entries.push(...choreEntries);
  }

  return entries.sort((left, right) =>
    left.suggestedDate.localeCompare(right.suggestedDate)
    || loadRank(choresById.get(right.choreId)?.load ?? 'light') - loadRank(choresById.get(left.choreId)?.load ?? 'light')
    || left.choreId.localeCompare(right.choreId),
  );
}

function createOverdueEntry(options: {
  chore: ChoreDefinition;
  entryId: EntityId;
  originalBaseDate: LocalDate;
  overdueDays: number;
  overdueCycles: number;
  assignedMemberIds: EntityId[];
  input: ScheduleGenerationInput;
  loadByDate: Map<LocalDate, DayLoad>;
}): ChoreScheduleEntry {
  const candidate = findCandidate({
    chore: options.chore,
    baseDate: options.input.from,
    radius: 0,
    maxShift: daysBetween(options.input.from, options.input.through),
    minDate: options.input.from,
    from: options.input.from,
    through: options.input.through,
    restDays: options.input.settings.restDays,
    loadByDate: options.loadByDate,
    limits: options.input.settings.loadLimits,
  });
  const suggestedDate = candidate?.suggestedDate ?? options.input.from;
  reserveLoad(options.chore, suggestedDate, options.loadByDate);
  return {
    id: options.entryId,
    householdId: options.input.householdId,
    choreId: options.chore.id,
    cycleBaseDate: options.originalBaseDate,
    windowStart: suggestedDate,
    windowEnd: suggestedDate,
    suggestedDate,
    status: 'overdue',
    assignedMemberIds: options.assignedMemberIds,
    overdueDays: options.overdueDays,
    overdueCycles: options.overdueCycles,
  };
}

function appendRecurringEntries(options: {
  chore: ChoreDefinition;
  cycleDays: number;
  radius: number;
  maxShift: number;
  firstBaseDate: LocalDate;
  firstOccurrence: number;
  assignment: EntityId[];
  input: ScheduleGenerationInput;
  entriesByChore: ReadonlyMap<EntityId, readonly ChoreScheduleEntry[]>;
  loadByDate: Map<LocalDate, DayLoad>;
  choreEntries: ChoreScheduleEntry[];
}): void {
  let baseDate = options.firstBaseDate;
  let occurrence = options.firstOccurrence;
  while (
    daysBetween(options.input.from, addDays(baseDate, -options.radius))
      <= daysBetween(options.input.from, options.input.through)
  ) {
    const dependencyDate = latestDependencyDate(
      options.chore.id,
      options.input.dependencies,
      options.entriesByChore,
      occurrence,
    );
    const candidate = findCandidate({
      chore: options.chore,
      baseDate,
      radius: options.radius,
      maxShift: options.maxShift,
      minDate: dependencyDate && dependencyDate > options.input.from ? dependencyDate : options.input.from,
      from: options.input.from,
      through: options.input.through,
      restDays: options.input.settings.restDays,
      loadByDate: options.loadByDate,
      limits: options.input.settings.loadLimits,
    });
    if (candidate) {
      reserveLoad(options.chore, candidate.suggestedDate, options.loadByDate);
      const status = options.input.today > candidate.windowEnd
        ? 'overdue'
        : options.input.today >= candidate.windowStart
          ? 'inWindow'
          : 'scheduled';
      options.choreEntries.push({
        id: `${options.chore.id}:${baseDate}`,
        householdId: options.input.householdId,
        choreId: options.chore.id,
        cycleBaseDate: baseDate,
        windowStart: candidate.windowStart,
        windowEnd: candidate.windowEnd,
        suggestedDate: candidate.suggestedDate,
        status,
        assignedMemberIds: options.assignment,
      });
    }
    baseDate = addDays(baseDate, options.cycleDays);
    occurrence += 1;
    if (occurrence > 500) {
      throw new RangeError(`Schedule horizon is too large for chore ${options.chore.id}`);
    }
  }
}

function effectiveCycleDays(chore: ChoreDefinition, mode: ScheduleGenerationInput['settings']['frequencyMode']): number {
  const days = chore.recommendedCycleDays
    ?? chore.manufacturerRecommendedIntervalDays
    ?? chore.frequencyDaysByMode[mode];
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`Chore ${chore.id} must have a positive cycle in days`);
  }
  return days;
}

function latestCompletionDates(completions: readonly ChoreCompletion[]): Map<EntityId, LocalDate> {
  const latest = new Map<EntityId, LocalDate>();
  for (const completion of completions) {
    if (completion.outcome === 'incomplete') continue;
    const date = localDateFromISODateTime(completion.completedAt);
    if (!latest.has(completion.choreId) || date > latest.get(completion.choreId)!) {
      latest.set(completion.choreId, date);
    }
  }
  return latest;
}

function findCandidate(input: {
  chore: ChoreDefinition;
  baseDate: LocalDate;
  radius: number;
  maxShift: number;
  minDate: LocalDate;
  from: LocalDate;
  through: LocalDate;
  restDays: readonly Weekday[];
  loadByDate: Map<LocalDate, DayLoad>;
  limits: ScheduleGenerationInput['settings']['loadLimits'];
}): Candidate | undefined {
  const restDaySet = new Set(input.restDays);
  let best: Candidate | undefined;

  for (const offset of orderedOffsets(input.maxShift)) {
    const shiftedBase = addDays(input.baseDate, offset);
    const windowStart = addDays(shiftedBase, -input.radius);
    const windowEnd = addDays(shiftedBase, input.radius);
    if (windowEnd < input.from || windowStart > input.through) continue;

    const dates: LocalDate[] = [];
    for (let date = windowStart; date <= windowEnd; date = addDays(date, 1)) {
      if (date >= input.minDate && date >= input.from && date <= input.through) dates.push(date);
    }
    if (dates.length === 0) continue;

    const includesRestDay = rangeIncludesWeekday(windowStart, windowEnd, restDaySet);
    const restPenalty = input.chore.holidayPriority && restDaySet.size > 0 && !includesRestDay ? 1 : 0;
    for (const date of dates) {
      const load = input.loadByDate.get(date) ?? ZERO_LOAD;
      const score = [
        capacityOverflow(input.chore.load, load, input.limits),
        restPenalty,
        Math.abs(offset),
        load.total,
        Math.abs(daysBetween(input.baseDate, date)),
      ];
      if (!best || compareScore(score, best.score) < 0) {
        best = { windowStart, windowEnd, suggestedDate: date, score };
      }
    }
  }
  return best;
}

function capacityOverflow(
  load: ChoreDefinition['load'],
  current: DayLoad,
  limits: ScheduleGenerationInput['settings']['loadLimits'],
): number {
  if (load === 'heavy') return Math.max(0, current.heavy + 1 - limits.heavyDailyLimit) * 100;
  if (load === 'normal') return Math.max(0, current.normal + 1 - limits.normalDailyLimit) * 20;
  return 0;
}

function reserveLoad(chore: ChoreDefinition, date: LocalDate, loadByDate: Map<LocalDate, DayLoad>): void {
  const current = { ...(loadByDate.get(date) ?? ZERO_LOAD) };
  if (chore.load === 'heavy') current.heavy += 1;
  if (chore.load === 'normal') current.normal += 1;
  current.total += 1;
  loadByDate.set(date, current);
}

function orderedOffsets(maxShift: number): number[] {
  const offsets = [0];
  for (let amount = 1; amount <= maxShift; amount += 1) offsets.push(-amount, amount);
  return offsets;
}

function rangeIncludesWeekday(start: LocalDate, end: LocalDate, weekdays: ReadonlySet<Weekday>): boolean {
  for (let date = start; date <= end; date = addDays(date, 1)) {
    if (weekdays.has(weekdayOf(date))) return true;
  }
  return false;
}

function compareScore(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] < right[index]) return -1;
    if (left[index] > right[index]) return 1;
  }
  return 0;
}

function loadRank(load: ChoreDefinition['load']): number {
  if (load === 'heavy') return 3;
  if (load === 'normal') return 2;
  return 1;
}

function latestDependencyDate(
  choreId: EntityId,
  dependencies: readonly ChoreDependency[],
  entriesByChore: ReadonlyMap<EntityId, readonly ChoreScheduleEntry[]>,
  occurrenceIndex: number,
): LocalDate | undefined {
  let latest: LocalDate | undefined;
  for (const dependency of dependencies.filter((item) => item.successorChoreId === choreId)) {
    const entries = entriesByChore.get(dependency.predecessorChoreId) ?? [];
    const predecessor = entries[Math.min(occurrenceIndex, entries.length - 1)];
    if (predecessor && (!latest || predecessor.suggestedDate > latest)) latest = predecessor.suggestedDate;
  }
  return latest;
}

function topologicalOrder(
  chores: readonly ChoreDefinition[],
  dependencies: readonly ChoreDependency[],
): ChoreDefinition[] {
  const byId = new Map(chores.map((chore) => [chore.id, chore]));
  const incomingCount = new Map(chores.map((chore) => [chore.id, 0]));
  const successors = new Map<EntityId, EntityId[]>();
  for (const dependency of dependencies) {
    if (!byId.has(dependency.predecessorChoreId) || !byId.has(dependency.successorChoreId)) continue;
    if (dependency.predecessorChoreId === dependency.successorChoreId) throw new RangeError('A chore cannot depend on itself');
    successors.set(dependency.predecessorChoreId, [...(successors.get(dependency.predecessorChoreId) ?? []), dependency.successorChoreId]);
    incomingCount.set(dependency.successorChoreId, (incomingCount.get(dependency.successorChoreId) ?? 0) + 1);
  }

  const ready = chores.filter((chore) => incomingCount.get(chore.id) === 0);
  const result: ChoreDefinition[] = [];
  while (ready.length > 0) {
    const chore = ready.shift()!;
    result.push(chore);
    for (const successorId of successors.get(chore.id) ?? []) {
      const next = (incomingCount.get(successorId) ?? 1) - 1;
      incomingCount.set(successorId, next);
      if (next === 0) ready.push(byId.get(successorId)!);
    }
  }
  if (result.length !== chores.length) throw new RangeError('Chore dependencies contain a cycle');
  return result;
}

export function wouldCreateDependencyCycle(
  dependencies: readonly ChoreDependency[],
  predecessorChoreId: EntityId,
  successorChoreId: EntityId,
): boolean {
  if (predecessorChoreId === successorChoreId) return true;
  const adjacency = new Map<EntityId, EntityId[]>();
  for (const dependency of dependencies) {
    adjacency.set(dependency.predecessorChoreId, [...(adjacency.get(dependency.predecessorChoreId) ?? []), dependency.successorChoreId]);
  }
  adjacency.set(predecessorChoreId, [...(adjacency.get(predecessorChoreId) ?? []), successorChoreId]);

  const visited = new Set<EntityId>();
  const stack = [successorChoreId];
  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === predecessorChoreId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    stack.push(...(adjacency.get(current) ?? []));
  }
  return false;
}
