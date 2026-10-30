import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { canonicalJson, causallyPrecedes, compareOperationIds } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';
import { normalizeV2Configuration } from './configuration-normalization.ts';

export interface V2ConfigurationSlice {
  from: LocalDate; through: LocalDate | null; version: number; configuration: SharedChoreConfiguration | null;
  operationIds: string[]; review: 'configurationConflict' | 'effectiveDateRequired' | 'nonmonotonicEffectiveDate' | null;
}
/** Validity is temporal and causal. A larger revision cannot hide an unobserved concurrent configuration. */
export function v2ConfigurationTimeline(view: V2HistoryView, choreId: string, at: SharedOperation): V2ConfigurationSlice[] {
  const facts = view.observed(view.topic('chorePolicy', choreId), at).map((operation) => {
    const configuration = normalizeV2Configuration(operation.payload.configuration as unknown as SharedChoreConfiguration);
    const from = configuration.effectiveFrom ?? configuration.anchorDate; parseLocalDate(from);
    return { operation, configuration, from };
  });
  const byDevice = new Map<string, { sequence: number; maximumFrom: LocalDate }[]>();
  for (const entry of [...facts].sort((a, b) => a.operation.deviceSequence - b.operation.deviceSequence)) {
    const device = entry.operation.authorDeviceId; const list = byDevice.get(device) ?? []; const previous = list.at(-1)?.maximumFrom;
    list.push({ sequence: entry.operation.deviceSequence, maximumFrom: previous && previous > entry.from ? previous : entry.from }); byDevice.set(device, list);
  }
  function observedMaximumFrom(operation: SharedOperation): LocalDate | null {
    let result: LocalDate | null = null;
    for (const [device, sequence] of Object.entries(operation.context)) {
      const list = byDevice.get(device) ?? []; let low = 0; let high = list.length;
      while (low < high) { const middle = (low + high) >>> 1; if (list[middle].sequence <= sequence) low = middle + 1; else high = middle; }
      const date = list[low - 1]?.maximumFrom; if (date && (!result || date > result)) result = date;
    }
    return result;
  }
  const ordered = facts.map((entry) => {
    const prior = observedMaximumFrom(entry.operation);
    const review: V2ConfigurationSlice['review'] = entry.configuration.ruleVersion > 1 && !entry.configuration.effectiveFrom ? 'effectiveDateRequired'
      : prior && entry.from < prior ? 'nonmonotonicEffectiveDate' : null;
    return { ...entry, review };
  }).sort((a, b) => compareOperationIds(a.from, b.from) || a.operation.logicalClock - b.operation.logicalClock || compareOperationIds(a.operation.operationId, b.operation.operationId));
  const frontier = new Map<string, typeof ordered[number]>(); const result: V2ConfigurationSlice[] = [];
  for (let index = 0; index < ordered.length;) {
    const from = ordered[index].from;
    do {
      const entry = ordered[index++]; let dominated = false;
      for (const [id, existing] of frontier) {
        if (causallyPrecedes(entry.operation, existing.operation)) dominated = true;
        if (causallyPrecedes(existing.operation, entry.operation)) frontier.delete(id);
      }
      if (!dominated) frontier.set(entry.operation.operationId, entry);
    } while (index < ordered.length && ordered[index].from === from);
    const active = [...frontier.values()].sort((a, b) => compareOperationIds(a.operation.operationId, b.operation.operationId));
    const review = new Set(active.map((entry) => canonicalJson(entry.configuration))).size > 1 ? 'configurationConflict'
      : active.find((entry) => entry.review)?.review ?? null;
    const through = index < ordered.length ? addDays(ordered[index].from, -1) : null;
    const slice: V2ConfigurationSlice = { from, through, version: Math.max(...active.map((entry) => entry.configuration.ruleVersion)),
      configuration: review ? null : active[0].configuration, operationIds: active.map((entry) => entry.operation.operationId), review };
    const previous = result.at(-1);
    if (previous && canonicalJson({ ...previous, from: null, through: null }) === canonicalJson({ ...slice, from: null, through: null })) previous.through = through;
    else result.push(slice);
  }
  return result;
}
