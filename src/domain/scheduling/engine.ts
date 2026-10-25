import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
} from '@/domain/chores/types';
import type { ScheduleGenerationInput } from '@/domain/scheduling/contracts';
import type { EntityId, LocalDate, Weekday } from '@/domain/shared/types';
import { completionCycleDate, completionWasRecordedBeforeWindow } from './completion-matching.ts';
import { addDays, daysBetween, weekdayOf } from './local-date.ts';

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
const OVERDUE_GRACE_DAYS = 3;

/** Shared rule-based scheduler for regular and first-run housework. */
export function generateHouseworkSchedule(input: ScheduleGenerationInput): ChoreScheduleEntry[] {
  return generateHouseworkScheduleResult(input).entries;
}

export interface ScheduleGenerationResult {
  entries: ChoreScheduleEntry[];
  /** Dates that should advance recurring schedules without adding a user completion record. */
  simulatedCompletions: { choreId: EntityId; date: LocalDate }[];
}

export function generateHouseworkScheduleResult(input: ScheduleGenerationInput): ScheduleGenerationResult {
  if (daysBetween(input.from, input.through) < 0) {
    throw new RangeError('from must be on or before through');
  }

  const enabledChores = input.chores.filter((chore) => chore.enabled);
  const choresById = new Map(enabledChores.map((chore) => [chore.id, chore]));
  const orderedChores = topologicalOrder(enabledChores, input.dependencies);
  const stateByChore = new Map(input.states.map((state) => [state.choreId, state]));
  const assignmentByChore = new Map(input.assignments.map((assignment) => [assignment.choreId, assignment.memberIds]));
  const lastCompletionByChore = latestCompletionDates(input.completions, input.today);
  // A future checkmark must not consume today's pending occurrence. It takes effect on its scheduled day.
  for (const completion of input.completions) {
    if (completion.outcome !== 'completed' || !completionWasRecordedBeforeWindow(completion)) continue;
    const date = completionCycleDate(completion);
    const state = stateByChore.get(completion.choreId);
    if (date > input.today || (state?.lastCompletedDate && date < state.lastCompletedDate)) continue;
    stateByChore.set(completion.choreId, {
      choreId: completion.choreId,
      lastCompletedDate: date,
      lastCompletedEstimated: false,
      initialPending: false,
    });
  }
  const previousEntriesById = new Map((input.previousScheduleEntries ?? []).map((entry) => [entry.id, entry]));
  const simulatedCompletionByChore = new Map<EntityId, LocalDate>();
  const loadByDate = new Map<LocalDate, DayLoad>();
  const entriesByChore = new Map<EntityId, ChoreScheduleEntry[]>();
  const entries: ChoreScheduleEntry[] = [];

  for (const chore of enabledChores) {
    const state = stateByChore.get(chore.id);
    if (state?.initialPending && state.initialScheduledDate && state.initialScheduledDate >= input.today) {
      reserveLoad(chore, state.initialScheduledDate, loadByDate);
    }
  }

  for (const chore of orderedChores) {
    const state = stateByChore.get(chore.id);
    const stateDate = state?.lastCompletedDate;
    const completionDate = lastCompletionByChore.get(chore.id);
    const lastCompleted = stateDate ?? completionDate;
    const assignment = [...(assignmentByChore.get(chore.id) ?? [])];
    const cycleDays = effectiveCycleDays(chore, input.settings.frequencyMode);
    const radius = chore.load === 'light'
      ? 0
      : Math.max(0, chore.windowRadiusDays ?? (cycleDays < 30 ? 1 : 2));
    const maxShift = Math.max(0, chore.maxShiftDays ?? (cycleDays < 30 ? 4 : 7));
    const choreEntries: ChoreScheduleEntry[] = [];
    const recordSimulatedCompletion = (date: LocalDate) => {
      const previous = simulatedCompletionByChore.get(chore.id);
      if (!previous || date > previous) simulatedCompletionByChore.set(chore.id, date);
    };

    if (state?.initialPending && state.initialScheduledDate) {
      const initialDate = state.initialScheduledDate;
      const initialExpired = input.today > addDays(initialDate, OVERDUE_GRACE_DAYS);
      if (initialExpired) recordSimulatedCompletion(initialDate);
      if (!initialExpired && input.today > initialDate) {
        choreEntries.push(createOverdueEntry({
          chore,
          entryId: `${chore.id}:initial`,
          cycleBaseDate: initialDate,
          windowStart: initialDate,
          windowEnd: initialDate,
          suggestedDate: initialDate,
          overdueDays: Math.max(1, daysBetween(initialDate, input.today)),
          overdueCycles: 1,
          assignedMemberIds: assignment,
          input,
        }));
      } else if (!initialExpired) {
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
        firstBaseDate: addDays(initialDate, cycleDays),
        firstOccurrence: 1,
        cycleAnchorDate: initialDate,
        overdueCyclesBeforeFirst: initialExpired ? 1 : 0,
        assignment,
        input,
        entriesByChore,
        previousEntriesById,
        onSimulatedCompletion: recordSimulatedCompletion,
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
          cycleAnchorDate: candidate.suggestedDate,
          overdueCyclesBeforeFirst: 0,
          assignment,
          input,
          entriesByChore,
          previousEntriesById,
          onSimulatedCompletion: recordSimulatedCompletion,
          loadByDate,
          choreEntries,
        });
      }
    } else {
      appendRecurringEntries({
        chore,
        cycleDays,
        radius,
        maxShift,
        firstBaseDate: addDays(lastCompleted, cycleDays),
        firstOccurrence: 1,
        cycleAnchorDate: lastCompleted,
        overdueCyclesBeforeFirst: 0,
        assignment,
        input,
        entriesByChore,
        previousEntriesById,
        onSimulatedCompletion: recordSimulatedCompletion,
        loadByDate,
        choreEntries,
      });
    }

    entriesByChore.set(chore.id, choreEntries);
    entries.push(...choreEntries);
  }

  const sortedEntries = entries.sort((left, right) =>
    left.suggestedDate.localeCompare(right.suggestedDate)
    || loadRank(choresById.get(right.choreId)?.load ?? 'light') - loadRank(choresById.get(left.choreId)?.load ?? 'light')
    || left.choreId.localeCompare(right.choreId),
  );
  return {
    entries: sortedEntries,
    simulatedCompletions: [...simulatedCompletionByChore].map(([choreId, date]) => ({ choreId, date })),
  };
}

function createOverdueEntry(options: {
  chore: ChoreDefinition;
  entryId: EntityId;
  cycleBaseDate: LocalDate;
  windowStart: LocalDate;
  windowEnd: LocalDate;
  suggestedDate: LocalDate;
  overdueDays: number;
  overdueCycles: number;
  assignedMemberIds: EntityId[];
  input: ScheduleGenerationInput;
}): ChoreScheduleEntry {
  return {
    id: options.entryId,
    householdId: options.input.householdId,
    choreId: options.chore.id,
    cycleBaseDate: options.cycleBaseDate,
    windowStart: options.windowStart,
    windowEnd: options.windowEnd,
    suggestedDate: options.suggestedDate,
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
  cycleAnchorDate: LocalDate;
  overdueCyclesBeforeFirst: number;
  assignment: EntityId[];
  input: ScheduleGenerationInput;
  entriesByChore: ReadonlyMap<EntityId, readonly ChoreScheduleEntry[]>;
  previousEntriesById: ReadonlyMap<EntityId, ChoreScheduleEntry>;
  onSimulatedCompletion: (date: LocalDate) => void;
  loadByDate: Map<LocalDate, DayLoad>;
  choreEntries: ChoreScheduleEntry[];
}): void {
  let baseDate = options.firstBaseDate;
  let occurrence = options.firstOccurrence;
  let overdueCycles = options.overdueCyclesBeforeFirst;
  let cycleAnchorDate = options.cycleAnchorDate;
  let visitedCycles = 0;
  const latestBaseDate = addDays(options.input.through, options.maxShift + options.radius);
  while (baseDate <= latestBaseDate) {
    visitedCycles += 1;
    if (visitedCycles > 10000) {
      throw new RangeError(`Schedule horizon is too large for chore ${options.chore.id}`);
    }

    const entryId = `${options.chore.id}:${baseDate}`;
    const previous = options.previousEntriesById.get(entryId);
    const suggestedDate = previous && previous.suggestedDate >= previous.windowStart && previous.suggestedDate <= previous.windowEnd
      ? previous.suggestedDate
      : baseDate;
    const windowStart = options.chore.load === 'light'
      ? suggestedDate
      : previous?.windowStart ?? addDays(baseDate, -options.radius);
    const windowEnd = options.chore.load === 'light'
      ? suggestedDate
      : previous?.windowEnd ?? addDays(baseDate, options.radius);

    if (options.input.today > addDays(windowEnd, OVERDUE_GRACE_DAYS)) {
      overdueCycles += 1;
      const minimumAnchorForProgress = addDays(baseDate, 1 - options.cycleDays);
      const minimumAnchorAfterPrevious = addDays(cycleAnchorDate, 1);
      const minimumAnchor = minimumAnchorForProgress > minimumAnchorAfterPrevious
        ? minimumAnchorForProgress
        : minimumAnchorAfterPrevious;
      cycleAnchorDate = suggestedDate > minimumAnchor ? suggestedDate : minimumAnchor;
      options.onSimulatedCompletion(cycleAnchorDate);
      baseDate = addDays(cycleAnchorDate, options.cycleDays);
      occurrence += 1;
      continue;
    }

    if (options.input.today > windowEnd) {
      overdueCycles += 1;
      options.choreEntries.push(createOverdueEntry({
        chore: options.chore,
        entryId,
        cycleBaseDate: baseDate,
        windowStart,
        windowEnd,
        suggestedDate,
        overdueDays: Math.max(1, daysBetween(windowEnd, options.input.today)),
        overdueCycles,
        assignedMemberIds: options.assignment,
        input: options.input,
      }));
      baseDate = addDays(baseDate, options.cycleDays);
      occurrence += 1;
      continue;
    }

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
      const status = options.input.today >= candidate.windowStart
          ? 'inWindow'
          : 'scheduled';
      options.choreEntries.push({
        id: entryId,
        householdId: options.input.householdId,
        choreId: options.chore.id,
        cycleBaseDate: baseDate,
        windowStart: candidate.windowStart,
        windowEnd: candidate.windowEnd,
        suggestedDate: candidate.suggestedDate,
        status,
        assignedMemberIds: options.assignment,
      });
      baseDate = addDays(baseDate, options.cycleDays);
    } else {
      baseDate = addDays(baseDate, options.cycleDays);
    }
    occurrence += 1;
  }
}

function effectiveCycleDays(chore: ChoreDefinition, mode: ScheduleGenerationInput['settings']['frequencyMode']): number {
  const days = chore.userIntervalDays
    ?? chore.recommendedCycleDays
    ?? chore.manufacturerRecommendedIntervalDays
    ?? chore.frequencyDaysByMode[mode];
  if (!Number.isInteger(days) || days <= 0) {
    throw new RangeError(`Chore ${chore.id} must have a positive cycle in days`);
  }
  return days;
}

function latestCompletionDates(completions: readonly ChoreCompletion[], today: LocalDate): Map<EntityId, LocalDate> {
  const latest = new Map<EntityId, LocalDate>();
  for (const completion of completions) {
    if (completion.outcome === 'incomplete') continue;
    const date = completionCycleDate(completion);
    if (date > today) continue;
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
