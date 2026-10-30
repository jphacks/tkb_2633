import { addDays, parseLocalDate, weekdayOf } from '../../domain/scheduling/local-date.ts';
import type { LocalDate, Weekday } from '@/domain/shared/types';
import type { WasteRecurrence, WasteScheduleInput, WeeklyWasteSchedule } from './contracts';

export const wasteWeekdays: readonly { id: Weekday; label: string }[] = [
  { id: 1, label: '月' }, { id: 2, label: '火' }, { id: 3, label: '水' }, { id: 4, label: '木' },
  { id: 5, label: '金' }, { id: 6, label: '土' }, { id: 7, label: '日' },
];

export function nextWasteWeekday(today: LocalDate, weekday: Weekday): LocalDate {
  return addDays(today, (weekday - weekdayOf(today) + 7) % 7);
}

/** Used by both onboarding and settings; no save path may silently drop recurrence fields. */
export function normalizeWasteSchedule(input: WasteScheduleInput): WasteScheduleInput & { recurrence: WasteRecurrence } {
  const label = input.label.trim();
  const recurrence = input.recurrence ?? 'weekly';
  const weekdays = [...new Set(input.collectionWeekdays)].sort();
  if (!label || label.length > 80) throw new RangeError('ゴミの種類は1〜80文字で入力してください');
  if (!['weekly', 'biweekly', 'monthly'].includes(recurrence)) throw new RangeError('収集周期を確認してください');
  if (weekdays.some((day) => !Number.isInteger(day) || day < 1 || day > 7)) throw new RangeError('収集曜日を確認してください');
  if (input.anchorDate) parseLocalDate(input.anchorDate);
  if (recurrence === 'weekly' && !weekdays.length) throw new RangeError('収集曜日を1つ以上選択してください');
  if (recurrence === 'biweekly' && (weekdays.length !== 1 || !input.anchorDate || weekdayOf(input.anchorDate) !== weekdays[0])) {
    throw new RangeError('隔週の収集曜日と最初の収集日を選んでください');
  }
  if (recurrence === 'monthly' && (!Number.isInteger(input.monthlyDay) || input.monthlyDay! < 1 || input.monthlyDay! > 31)) {
    throw new RangeError('毎月の収集日を1〜31日の整数で入力してください');
  }
  return {
    ...(input.id ? { id: input.id } : {}), label, recurrence,
    collectionWeekdays: recurrence === 'monthly' ? [] : weekdays,
    ...(recurrence !== 'weekly' && input.anchorDate ? { anchorDate: input.anchorDate } : {}),
    ...(recurrence === 'monthly' ? { monthlyDay: input.monthlyDay } : {}),
  };
}

/** These fields describe one rule; mixing independently edited parts can create an invalid date. */
export function wasteCollectionRule(input: WasteScheduleInput) {
  const value = normalizeWasteSchedule(input);
  return { recurrence: value.recurrence, collectionWeekdays: [...value.collectionWeekdays],
    anchorDate: value.anchorDate ?? null, monthlyDay: value.monthlyDay ?? null };
}

/** Merge only edits made since the form opened, preserving unrelated newer changes. */
export function mergeWasteScheduleEdits(current: WasteScheduleInput, proposed: WasteScheduleInput, base: WasteScheduleInput) {
  const latest = normalizeWasteSchedule(current); const next = normalizeWasteSchedule(proposed); const shown = normalizeWasteSchedule(base);
  if (!shown.id || shown.id !== next.id || latest.id !== next.id) throw new Error('収集日の保存先が一致しません。');
  const editedLabel = next.label !== shown.label;
  const rule = (value: WasteScheduleInput) => JSON.stringify(wasteCollectionRule(value));
  const editedRule = rule(next) !== rule(shown);
  if ((editedLabel && latest.label !== shown.label && latest.label !== next.label)
    || (editedRule && rule(latest) !== rule(shown) && rule(latest) !== rule(next))) {
    throw new Error('この収集日は別の端末で変更されました。編集をキャンセルして、最新の内容を開き直してください。');
  }
  return { ...(editedRule ? next : latest), label: editedLabel ? next.label : latest.label };
}

export function wasteScheduleDescription(schedule: Pick<WeeklyWasteSchedule, 'recurrence' | 'collectionWeekdays' | 'monthlyDay'>): string {
  if (schedule.recurrence === 'monthly') return `毎月${schedule.monthlyDay}日`;
  const days = schedule.collectionWeekdays.map((day) => `${wasteWeekdays.find((item) => item.id === day)?.label ?? ''}曜`).join('・');
  return `${schedule.recurrence === 'biweekly' ? '隔週' : '毎週'} ${days}`;
}
