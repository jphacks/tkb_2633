import { addDays, daysBetween } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import type { SharedOperation } from '../operations.ts';
import type { V2HistoryView } from './history-view.ts';
import { commonFrame } from './common-frames.ts';
import { v2ConfigurationTimeline } from './configuration-timeline.ts';

/** Search signed recurrence segments, rather than inventing a next round from an obsolete interval. */
export function nextV2CommonOccurrence(view: V2HistoryView, at: SharedOperation, choreId: string, after: LocalDate) {
  const tomorrow = addDays(after, 1);
  for (const slice of v2ConfigurationTimeline(view, choreId, at)) {
    if (slice.through !== null && slice.through < tomorrow) continue;
    if (slice.review || !slice.configuration) throw new Error('次回の周期設定が競合しています。先に共通設定を確認してください。');
    const configuration = slice.configuration; if (configuration.active === false) continue;
    const first = [tomorrow, slice.from, configuration.anchorDate].sort().at(-1)!;
    const index = Math.max(0, Math.ceil(daysBetween(configuration.anchorDate, first) / configuration.intervalDays));
    const anchor = addDays(configuration.anchorDate, index * configuration.intervalDays);
    if (slice.through !== null && anchor > slice.through) continue;
    return commonFrame(view.groupId, choreId, configuration, anchor);
  }
  throw new Error('次回の有効な家事回がありません。共通設定を確認してください。');
}
