import { addDays, monthDates, parseLocalDate, weekdayOf } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { V2GroupScreenModel } from '../v2/controller.ts';
import type { V2PersonalPlan } from '../v2/personal-plan.ts';
import { createV2RoundVisibility } from './round-visibility.ts';

export function v2CalendarMonth(day: LocalDate, offset = 0) {
  if (!Number.isSafeInteger(offset)) throw new RangeError('表示する月の移動量を確認してください。');
  const first = parseLocalDate(day); first.setUTCDate(1); first.setUTCMonth(first.getUTCMonth() + offset);
  const month = first.toISOString().slice(0, 10) as LocalDate; parseLocalDate(month);
  const dates = monthDates(first.getUTCFullYear(), first.getUTCMonth()); const start = addDays(month, -(weekdayOf(month) % 7));
  const cells = Array.from({ length: Math.ceil(((weekdayOf(month) % 7) + dates.length) / 7) * 7 }, (_, index) => addDays(start, index));
  cells.forEach(parseLocalDate);
  return { month, cells, from: cells[0], through: cells.at(-1)!, year: first.getUTCFullYear(), monthNumber: first.getUTCMonth() + 1 };
}

/** Local display only. Personal recommendations never change the common plan or another member's date. */
export function v2CalendarProjection(model: V2GroupScreenModel, personal?: V2PersonalPlan) {
  if (personal && (personal.viewerUserId !== model.viewerUserId || personal.groupId !== model.plan.groupId || personal.commonPlanHash !== model.plan.planHash)) {
    throw new Error('本人と現在の共有予定に対応する推奨を取得してください。');
  }
  const recommendations = new Map(personal?.recommendations.map((entry) => [entry.subjectOccurrenceId, entry]) ?? []);
  const visibility = createV2RoundVisibility(model);
  const entries = model.plan.occurrences.flatMap((round) => round.subjects.filter((subject) => subject.required || subject.completed || subject.pendingCompletionIds.length > 0).map((subject) => {
    const visible = visibility(round, subject);
    const candidate = recommendations.get(subject.id); const recommendation = candidate && visible.owns ? candidate : undefined;
    return { id: subject.id, round, subject, recommendation, date: recommendation?.date ?? subject.suggestedDate,
      counted: visible.showStatus && subject.required && !subject.completed };
  }));
  const byDate = new Map<LocalDate, typeof entries>(); const counts = new Map<LocalDate, number>();
  for (const entry of entries) {
    const list = byDate.get(entry.date) ?? []; list.push(entry); byDate.set(entry.date, list);
    if (entry.counted) counts.set(entry.date, (counts.get(entry.date) ?? 0) + 1);
  }
  for (const list of byDate.values()) list.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { byDate, counts };
}
