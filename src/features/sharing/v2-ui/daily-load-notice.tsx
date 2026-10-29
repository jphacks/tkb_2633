import { Text } from 'react-native';
import { Card, palette, typography } from '../../../components/planner-ui';
import { v2DailyLoadMessage } from '../v2/daily-load.ts';
import type { V2DailyLoadAssessment } from '../v2/daily-load';

export function V2DailyLoadNotice({ assessment }: { assessment?: V2DailyLoadAssessment }) {
  if (!assessment) return null;
  const message = v2DailyLoadMessage(assessment); if (!message) return null;
  return <Card><Text style={[typography.label, { color: palette.warning }]}>今日の負荷が上限に達しています</Text>
    <Text style={typography.caption}>{message}</Text>
    {assessment.privateStatus === 'unavailable' ? <Text style={typography.caption}>個人家事は未確認のため、共有家事の件数を表示しています。</Text> : null}
    <Text style={typography.caption}>時刻の入力は不要です。日単位の負荷だけを確認しています。</Text>
  </Card>;
}
