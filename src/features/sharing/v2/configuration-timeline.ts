import { addDays, parseLocalDate } from '../../../domain/scheduling/local-date.ts';
import type { LocalDate } from '../../../domain/shared/types.ts';
import { canonicalJson } from '../operations.ts';
import type { SharedOperation } from '../operations.ts';
import type { SharedChoreConfiguration } from './model.ts';
import type { V2HistoryView } from './history-view.ts';

export interface V2ConfigurationSlice {
  from: LocalDate; through: LocalDate | null; version: number; configuration: SharedChoreConfiguration | null;
  operationIds: string[]; review: 'configurationConflict' | 'effectiveDateRequired' | 'nonmonotonicEffectiveDate' | null;
}
/** Changing a cadence cannot rewrite prior uncompleted calendar rounds by silently applying the latest configuration to all dates. */
export function v2ConfigurationTimeline(view: V2HistoryView, choreId: string, at: SharedOperation): V2ConfigurationSlice[] {
  const versions = new Map<number, SharedOperation[]>();
  for (const op of view.observed(view.topic('chorePolicy', choreId), at)) {
    const configuration = op.payload.configuration as unknown as SharedChoreConfiguration;
    const list = versions.get(configuration.ruleVersion) ?? []; list.push(op); versions.set(configuration.ruleVersion, list);
  }
  const result = [...versions].sort(([a], [b]) => a - b).map(([version, ops]): V2ConfigurationSlice => {
    const values = ops.map((op) => op.payload.configuration as unknown as SharedChoreConfiguration);
    const different = new Set(values.map((configuration) => canonicalJson(configuration))).size > 1;
    const from = values.map((configuration) => configuration.effectiveFrom ?? configuration.anchorDate).sort()[0]; parseLocalDate(from);
    const missing = version > 1 && values.some((configuration) => !configuration.effectiveFrom);
    return { from, through: null, version, configuration: different || missing ? null : values[0], operationIds: ops.map((op) => op.operationId).sort(),
      review: different ? 'configurationConflict' : missing ? 'effectiveDateRequired' : null };
  });
  for (let index = 0; index < result.length - 1; index++) {
    const next = result[index + 1]; const current = result[index];
    if (next.from < current.from) {
      const beginning = result.map((slice) => slice.from).sort()[0];
      return [{ from: beginning, through: null, version: next.version, configuration: null,
        operationIds: result.flatMap((slice) => slice.operationIds), review: 'nonmonotonicEffectiveDate' }];
    }
    current.through = next.from === '0001-01-01' ? current.from : addDays(next.from, -1);
  }
  return result;
}
