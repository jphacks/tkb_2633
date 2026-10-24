import type { SQLiteDatabase } from 'expo-sqlite';

import { createHouseholdChoreDefinitions } from '@/domain/chores/catalog';
import type {
  ChoreCompletion,
  ChoreDefinition,
  ChoreDependency,
  ChoreScheduleEntry,
  ChoreState,
  FrequencyMode,
  HouseholdPlannerSettings,
} from '@/domain/chores/types';
import type { ScheduleGenerationInput } from '@/domain/scheduling/contracts';
import { generateHouseworkSchedule, wouldCreateDependencyCycle } from '@/domain/scheduling/engine';
import { addDays, localDateFromDate } from '@/domain/scheduling/local-date';
import type { EntityId, Household, HouseholdMember, LocalDate, Weekday } from '@/domain/shared/types';
import type { WeeklyWasteSchedule } from '@/features/waste/contracts';
import { generateWeeklyCollectionDates } from '@/features/waste/weekly-scheduler';
import { migrateLocalDatabase } from '@/platform/storage/migrations';

export const LOCAL_HOUSEHOLD_ID = 'local-household';
export const LOCAL_MEMBER_ID = 'local-member';

export interface PlannerSnapshot {
  household: Household;
  settings: HouseholdPlannerSettings;
  chores: ChoreDefinition[];
  states: ChoreState[];
  members: HouseholdMember[];
  assignments: { choreId: EntityId; memberIds: EntityId[] }[];
  dependencies: ChoreDependency[];
  scheduleEntries: ChoreScheduleEntry[];
  completions: ChoreCompletion[];
  wasteSchedules: WeeklyWasteSchedule[];
  upcomingWasteDates: ReturnType<typeof generateWeeklyCollectionDates>;
}

interface HouseholdRow {
  id: string;
  name: string;
  created_at: string;
}

interface SettingsRow {
  frequency_mode: FrequencyMode;
  rest_days_json: string;
  heavy_daily_limit: number;
  normal_daily_limit: number;
  notification_hour: number;
  notification_minute: number;
  setup_completed: number;
}

interface DefinitionRow {
  id: string;
  enabled: number;
  definition_json: string;
}

interface StateRow {
  chore_id: string;
  last_completed_date: string | null;
  last_completed_estimated: number;
  initial_pending: number;
  initial_scheduled_date: string | null;
  unknown_reason: 'unknown' | 'skipped' | null;
}

interface CompletionRow {
  id: string;
  household_id: string;
  chore_id: string;
  completed_at: string;
  completed_by_member_id: string | null;
  source: ChoreCompletion['source'] | null;
  schedule_entry_id: string | null;
}

interface DependencyRow {
  id: string;
  predecessor_chore_id: string;
  successor_chore_id: string;
  policy_json: string | null;
}

interface MemberRow {
  id: string;
  household_id: string;
  display_name: string;
}

interface AssignmentRow {
  chore_id: string;
  member_id: string;
}

interface WasteRow {
  id: string;
  household_id: string;
  label: string;
  weekdays_json: string;
}

export async function initializeLocalDatabase(database: SQLiteDatabase): Promise<void> {
  await migrateLocalDatabase(database);
  await ensureLocalHousehold(database);
}

export async function ensureLocalHousehold(database: SQLiteDatabase): Promise<void> {
  const now = new Date().toISOString();
  const definitions = createHouseholdChoreDefinitions(LOCAL_HOUSEHOLD_ID);
  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'INSERT OR IGNORE INTO households (id, name, created_at) VALUES (?, ?, ?)',
      LOCAL_HOUSEHOLD_ID, 'わが家', now,
    );
    await database.runAsync(
      'INSERT OR IGNORE INTO household_members (id, household_id, display_name) VALUES (?, ?, ?)',
      LOCAL_MEMBER_ID, LOCAL_HOUSEHOLD_ID, '自分',
    );
    await database.runAsync(
      `INSERT OR IGNORE INTO household_settings
       (household_id, frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
        notification_hour, notification_minute, setup_completed, updated_at)
       VALUES (?, 'balanced', '[6,7]', 1, 2, 9, 0, 0, ?)`,
      LOCAL_HOUSEHOLD_ID, now,
    );

    for (const definition of definitions) {
      await database.runAsync(
        'INSERT OR IGNORE INTO chore_definitions (id, household_id, name, enabled, definition_json) VALUES (?, ?, ?, 1, ?)',
        definition.id, definition.householdId, definition.name, JSON.stringify(definition),
      );
      await database.runAsync(
        'INSERT OR IGNORE INTO chore_state (chore_id, initial_pending, unknown_reason) VALUES (?, 1, ?)',
        definition.id, 'skipped',
      );
      await database.runAsync(
        'INSERT OR IGNORE INTO chore_assignments (chore_id, member_id) VALUES (?, ?)',
        definition.id, LOCAL_MEMBER_ID,
      );
    }
  });
}

export async function loadPlannerSnapshot(
  database: SQLiteDatabase,
  today = localDateFromDate(new Date()),
): Promise<PlannerSnapshot> {
  await ensureLocalHousehold(database);
  const householdRow = await database.getFirstAsync<HouseholdRow>(
    'SELECT id, name, created_at FROM households WHERE id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const settingsRow = await database.getFirstAsync<SettingsRow>(
    `SELECT frequency_mode, rest_days_json, heavy_daily_limit, normal_daily_limit,
            notification_hour, notification_minute, setup_completed
     FROM household_settings WHERE household_id = ?`, LOCAL_HOUSEHOLD_ID,
  );
  if (!householdRow || !settingsRow) throw new Error('Local household could not be initialized');

  const [definitionRows, stateRows, memberRows, assignmentRows, dependencyRows, completionRows, wasteRows] = await Promise.all([
    database.getAllAsync<DefinitionRow>(
      'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ? ORDER BY name', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<StateRow>(
      `SELECT s.chore_id, s.last_completed_date, s.last_completed_estimated, s.initial_pending,
              s.initial_scheduled_date, s.unknown_reason
       FROM chore_state s JOIN chore_definitions d ON d.id = s.chore_id WHERE d.household_id = ?`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<MemberRow>(
      'SELECT id, household_id, display_name FROM household_members WHERE household_id = ? ORDER BY display_name', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<AssignmentRow>(
      `SELECT a.chore_id, a.member_id FROM chore_assignments a
       JOIN chore_definitions d ON d.id = a.chore_id WHERE d.household_id = ?`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<DependencyRow>(
      'SELECT id, predecessor_chore_id, successor_chore_id, policy_json FROM chore_dependencies WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<CompletionRow>(
      `SELECT id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id
       FROM chore_completions WHERE household_id = ? ORDER BY completed_at DESC`, LOCAL_HOUSEHOLD_ID,
    ),
    database.getAllAsync<WasteRow>(
      'SELECT id, household_id, label, weekdays_json FROM weekly_waste_schedules WHERE household_id = ? ORDER BY label', LOCAL_HOUSEHOLD_ID,
    ),
  ]);

  const household: Household = {
    id: householdRow.id,
    name: householdRow.name,
    createdAt: householdRow.created_at,
  };
  const settings: HouseholdPlannerSettings = {
    householdId: householdRow.id,
    frequencyMode: settingsRow.frequency_mode,
    restDays: parseJson<number[]>(settingsRow.rest_days_json, [6, 7]),
    heavyDailyLimit: settingsRow.heavy_daily_limit,
    normalDailyLimit: settingsRow.normal_daily_limit,
    notificationHour: settingsRow.notification_hour,
    notificationMinute: settingsRow.notification_minute,
    setupCompleted: Boolean(settingsRow.setup_completed),
  };
  const chores = definitionRows.map((row) => ({
    ...(JSON.parse(row.definition_json) as ChoreDefinition),
    enabled: Boolean(row.enabled),
  }));
  const states = stateRows.map((row): ChoreState => ({
    choreId: row.chore_id,
    lastCompletedDate: (row.last_completed_date ?? undefined) as LocalDate | undefined,
    lastCompletedEstimated: Boolean(row.last_completed_estimated),
    initialPending: Boolean(row.initial_pending),
    initialScheduledDate: (row.initial_scheduled_date ?? undefined) as LocalDate | undefined,
    unknownReason: row.unknown_reason ?? undefined,
  }));
  const members = memberRows.map((row): HouseholdMember => ({
    id: row.id,
    householdId: row.household_id,
    displayName: row.display_name,
  }));
  const assignmentMap = new Map<EntityId, EntityId[]>();
  for (const assignment of assignmentRows) {
    assignmentMap.set(assignment.chore_id, [...(assignmentMap.get(assignment.chore_id) ?? []), assignment.member_id]);
  }
  const assignments = [...assignmentMap].map(([choreId, memberIds]) => ({ choreId, memberIds }));
  const dependencies: ChoreDependency[] = dependencyRows.map((row) => ({
    id: row.id,
    predecessorChoreId: row.predecessor_chore_id,
    successorChoreId: row.successor_chore_id,
    policyData: row.policy_json ? parseJson(row.policy_json, undefined) : undefined,
  }));
  const completions = completionRows.map((row): ChoreCompletion => ({
    id: row.id,
    householdId: row.household_id,
    choreId: row.chore_id,
    completedAt: row.completed_at,
    completedByMemberId: row.completed_by_member_id ?? undefined,
    source: row.source ?? undefined,
    scheduleEntryId: row.schedule_entry_id ?? undefined,
  }));
  const wasteSchedules = wasteRows.map((row): WeeklyWasteSchedule => ({
    id: row.id,
    householdId: row.household_id,
    label: row.label,
    collectionWeekdays: parseJson<Weekday[]>(row.weekdays_json, []),
  }));

  let scheduleEntries: ChoreScheduleEntry[] = [];
  if (settings.setupCompleted) {
    const input: ScheduleGenerationInput = {
      householdId: household.id,
      from: today,
      through: addDays(today, 180),
      today,
      chores,
      states,
      assignments,
      dependencies,
      completions,
      settings: {
        frequencyMode: settings.frequencyMode,
        restDays: settings.restDays as Weekday[],
        loadLimits: {
          heavyDailyLimit: settings.heavyDailyLimit,
          normalDailyLimit: settings.normalDailyLimit,
        },
      },
    };
    scheduleEntries = generateHouseworkSchedule(input);
    await replaceGeneratedSchedule(database, household.id, scheduleEntries);
  }

  const upcomingWasteDates = wasteSchedules.flatMap((schedule) =>
    generateWeeklyCollectionDates(schedule, today, addDays(today, 35)),
  );

  return {
    household,
    settings,
    chores,
    states,
    members,
    assignments,
    dependencies,
    scheduleEntries,
    completions,
    wasteSchedules,
    upcomingWasteDates,
  };
}

async function replaceGeneratedSchedule(
  database: SQLiteDatabase,
  householdId: EntityId,
  entries: readonly ChoreScheduleEntry[],
): Promise<void> {
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM chore_schedule_entries WHERE household_id = ?', householdId);
    for (const entry of entries) {
      await database.runAsync(
        `INSERT INTO chore_schedule_entries
         (id, household_id, chore_id, window_start, window_end, suggested_date, status, entry_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        entry.id, entry.householdId, entry.choreId, entry.windowStart, entry.windowEnd,
        entry.suggestedDate, entry.status, JSON.stringify(entry),
      );
      if (entry.id === `${entry.choreId}:initial`) {
        await database.runAsync(
          `UPDATE chore_state SET initial_scheduled_date = ?
           WHERE chore_id = ? AND initial_pending = 1 AND initial_scheduled_date IS NULL`,
          entry.suggestedDate, entry.choreId,
        );
      }
    }
  });
}

export interface SetupSubmission {
  frequencyMode: FrequencyMode;
  restDays: Weekday[];
  enabledChoreIds: EntityId[];
  previousDates: Record<EntityId, { date?: LocalDate; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' }>;
}

export async function completeFirstSetup(database: SQLiteDatabase, submission: SetupSubmission): Promise<void> {
  const enabled = new Set(submission.enabledChoreIds);
  const definitions = await database.getAllAsync<DefinitionRow>(
    'SELECT id, enabled, definition_json FROM chore_definitions WHERE household_id = ?', LOCAL_HOUSEHOLD_ID,
  );
  const now = new Date().toISOString();

  await database.withTransactionAsync(async () => {
    await database.runAsync(
      `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, setup_completed = 1, updated_at = ?
       WHERE household_id = ?`,
      submission.frequencyMode, JSON.stringify(submission.restDays), now, LOCAL_HOUSEHOLD_ID,
    );
    for (const row of definitions) {
      const isEnabled = enabled.has(row.id);
      const definition = { ...(JSON.parse(row.definition_json) as ChoreDefinition), enabled: isEnabled };
      await database.runAsync(
        'UPDATE chore_definitions SET enabled = ?, definition_json = ? WHERE id = ?',
        isEnabled ? 1 : 0, JSON.stringify(definition), row.id,
      );
      const previous = submission.previousDates[row.id] ?? { unknownReason: 'skipped' as const };
      await database.runAsync(
        `INSERT INTO chore_state
         (chore_id, last_completed_date, last_completed_estimated, initial_pending, initial_scheduled_date, unknown_reason)
         VALUES (?, ?, ?, ?, NULL, ?)
         ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
         last_completed_estimated = excluded.last_completed_estimated, initial_pending = excluded.initial_pending,
         initial_scheduled_date = NULL, unknown_reason = excluded.unknown_reason`,
        row.id, isEnabled ? previous.date ?? null : null, previous.estimated ? 1 : 0,
        isEnabled && !previous.date ? 1 : 0, isEnabled && !previous.date ? previous.unknownReason ?? 'skipped' : null,
      );
    }
  });
}

export async function updatePlannerSettings(
  database: SQLiteDatabase,
  settings: Pick<HouseholdPlannerSettings, 'frequencyMode' | 'restDays' | 'heavyDailyLimit' | 'normalDailyLimit'>,
): Promise<void> {
  await database.runAsync(
    `UPDATE household_settings SET frequency_mode = ?, rest_days_json = ?, heavy_daily_limit = ?,
     normal_daily_limit = ?, updated_at = ? WHERE household_id = ?`,
    settings.frequencyMode, JSON.stringify(settings.restDays), settings.heavyDailyLimit,
    settings.normalDailyLimit, new Date().toISOString(), LOCAL_HOUSEHOLD_ID,
  );
}

export async function updateChoreDefinition(
  database: SQLiteDatabase,
  definition: ChoreDefinition,
): Promise<void> {
  await database.runAsync(
    'UPDATE chore_definitions SET name = ?, enabled = ?, definition_json = ? WHERE id = ?',
    definition.name, definition.enabled ? 1 : 0, JSON.stringify(definition), definition.id,
  );
}

export async function setChoreEnabled(database: SQLiteDatabase, choreId: EntityId, enabled: boolean): Promise<void> {
  const row = await database.getFirstAsync<{ definition_json: string }>(
    'SELECT definition_json FROM chore_definitions WHERE id = ?', choreId,
  );
  if (!row) throw new Error('Chore not found');
  const definition = { ...(JSON.parse(row.definition_json) as ChoreDefinition), enabled };
  await database.runAsync(
    'UPDATE chore_definitions SET enabled = ?, definition_json = ? WHERE id = ?',
    enabled ? 1 : 0, JSON.stringify(definition), choreId,
  );
}

export async function completeChore(
  database: SQLiteDatabase,
  entry: ChoreScheduleEntry,
  memberId?: EntityId,
): Promise<boolean> {
  if (entry.status === 'initialPending' && !entry.id.endsWith(':initial')) return false;
  let inserted = false;
  const completedAt = new Date();
  const completedDate = localDateFromDate(completedAt);
  await database.withTransactionAsync(async () => {
    const existing = await database.getFirstAsync<{ id: string }>(
      'SELECT id FROM chore_completions WHERE schedule_entry_id = ?', entry.id,
    );
    if (existing) return;
    await database.runAsync(
      `INSERT INTO chore_completions
       (id, household_id, chore_id, completed_at, completed_by_member_id, source, schedule_entry_id)
       VALUES (?, ?, ?, ?, ?, 'inApp', ?)`,
      createId('completion'), entry.householdId, entry.choreId, completedAt.toISOString(), memberId ?? null, entry.id,
    );
    await database.runAsync(
      `INSERT INTO chore_state (chore_id, last_completed_date, last_completed_estimated, initial_pending, unknown_reason)
       VALUES (?, ?, 0, 0, NULL)
       ON CONFLICT(chore_id) DO UPDATE SET last_completed_date = excluded.last_completed_date,
       last_completed_estimated = 0, initial_pending = 0, initial_scheduled_date = NULL, unknown_reason = NULL`,
      entry.choreId, completedDate,
    );
    inserted = true;
  });
  return inserted;
}

export async function setChoreAssignments(
  database: SQLiteDatabase,
  choreId: EntityId,
  memberIds: readonly EntityId[],
): Promise<void> {
  await database.withTransactionAsync(async () => {
    await database.runAsync('DELETE FROM chore_assignments WHERE chore_id = ?', choreId);
    for (const memberId of new Set(memberIds)) {
      await database.runAsync(
        'INSERT OR IGNORE INTO chore_assignments (chore_id, member_id) VALUES (?, ?)', choreId, memberId,
      );
    }
  });
}

export async function addHouseholdMember(database: SQLiteDatabase, displayName: string): Promise<EntityId> {
  const normalized = displayName.trim();
  if (!normalized) throw new Error('メンバー名を入力してください');
  const id = createId('member');
  await database.runAsync(
    'INSERT INTO household_members (id, household_id, display_name) VALUES (?, ?, ?)',
    id, LOCAL_HOUSEHOLD_ID, normalized,
  );
  return id;
}

export async function replaceChoreDependencies(
  database: SQLiteDatabase,
  successorChoreId: EntityId,
  predecessorChoreIds: readonly EntityId[],
): Promise<void> {
  const existing = await database.getAllAsync<DependencyRow>(
    'SELECT id, predecessor_chore_id, successor_chore_id, policy_json FROM chore_dependencies WHERE household_id = ?',
    LOCAL_HOUSEHOLD_ID,
  );
  const dependencies: ChoreDependency[] = existing.map((row) => ({
    id: row.id,
    predecessorChoreId: row.predecessor_chore_id,
    successorChoreId: row.successor_chore_id,
  }));
  const nextIds = [...new Set(predecessorChoreIds)];
  const retained = dependencies.filter((item) => item.successorChoreId !== successorChoreId);
  const proposed = [...retained];
  for (const predecessorId of nextIds) {
    if (wouldCreateDependencyCycle(proposed, predecessorId, successorChoreId)) {
      throw new Error('家事の依存関係が循環するため保存できません');
    }
    proposed.push({
      id: `proposed-${predecessorId}`,
      predecessorChoreId: predecessorId,
      successorChoreId,
    });
  }

  await database.withTransactionAsync(async () => {
    await database.runAsync(
      'DELETE FROM chore_dependencies WHERE household_id = ? AND successor_chore_id = ?',
      LOCAL_HOUSEHOLD_ID, successorChoreId,
    );
    for (const predecessorId of nextIds) {
      await database.runAsync(
        `INSERT INTO chore_dependencies (id, household_id, predecessor_chore_id, successor_chore_id)
         VALUES (?, ?, ?, ?)`,
        createId('dependency'), LOCAL_HOUSEHOLD_ID, predecessorId, successorChoreId,
      );
    }
  });
}

export async function saveWeeklyWasteSchedule(
  database: SQLiteDatabase,
  schedule: { id?: EntityId; label: string; collectionWeekdays: readonly Weekday[] },
): Promise<void> {
  const label = schedule.label.trim();
  const weekdays = [...new Set(schedule.collectionWeekdays)].sort();
  if (!label) throw new Error('ゴミの種類を入力してください');
  if (weekdays.length === 0) throw new Error('収集曜日を1つ以上選択してください');
  const id = schedule.id ?? createId('waste');
  await database.runAsync(
    `INSERT INTO weekly_waste_schedules (id, household_id, label, weekdays_json)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET label = excluded.label, weekdays_json = excluded.weekdays_json`,
    id, LOCAL_HOUSEHOLD_ID, label, JSON.stringify(weekdays),
  );
}

export async function deleteWeeklyWasteSchedule(database: SQLiteDatabase, scheduleId: EntityId): Promise<void> {
  await database.runAsync(
    'DELETE FROM weekly_waste_schedules WHERE id = ? AND household_id = ?', scheduleId, LOCAL_HOUSEHOLD_ID,
  );
}

export function nextInitialDateChoice(today: LocalDate, choice: 'today' | 'week' | 'month' | 'unknown'):
  { date?: LocalDate; estimated?: boolean; unknownReason?: 'unknown' | 'skipped' } {
  if (choice === 'today') return { date: today };
  if (choice === 'week') return { date: addDays(today, -7), estimated: true };
  if (choice === 'month') return { date: addDays(today, -30), estimated: true };
  return { unknownReason: 'unknown' };
}

function createId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 9);
  return `${prefix}-${Date.now().toString(36)}-${random}`;
}

function parseJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}
