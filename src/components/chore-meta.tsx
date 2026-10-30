import { StyleSheet, Text } from 'react-native';
import type { ChoreDefinition, FrequencyMode } from '../domain/chores/types';
import { palette, typography } from './planner-ui';

export function ChoreMeta({ chore, mode }: { chore: ChoreDefinition; mode: FrequencyMode }) {
  const days = chore.requiresCycleSelection ? undefined : chore.userIntervalDays ?? chore.recommendedCycleDays ?? chore.manufacturerRecommendedIntervalDays ?? chore.frequencyDaysByMode[mode];
  return <Text style={styles.meta}>{days === undefined ? '周期未設定' : days === 1 ? '毎日' : `${days}日ごと`}
    {chore.estimatedMinutes ? ` · 目安 約${chore.estimatedMinutes}分` : ' · 所要時間は未登録'}</Text>;
}
const styles = StyleSheet.create({ meta: { ...typography.label, color: palette.muted, fontWeight: '500' } });
