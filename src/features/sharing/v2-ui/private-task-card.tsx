import { useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card } from '../../../components/planner-ui';
import { TaskCheckboxRow } from '../../../components/task-checkbox-row';
import { formatJapaneseDate } from '../../../domain/scheduling/local-date';
import type { V2PrivateOverlayState, V2PrivateTaskRow, V2PrivateTaskSource } from './private-overlay';
import { v2FormStyles as styles } from './form-controls';
import { V2ChoreProcedures } from './chore-procedures';

export function V2PrivateTaskNotice({ overlay, sharedTimeZone, date }: { overlay?: V2PrivateOverlayState; sharedTimeZone: string; date?: string }) {
  if (!overlay) return null;
  if (overlay.status === 'unavailable') return <Text accessibilityRole="alert" style={styles.caption}>{overlay.message}</Text>;
  return <View style={{ gap: 4 }}>
    <Text style={styles.caption}>個人家事：本人のみ · {overlay.timeZone}</Text>
    {overlay.timeZone !== sharedTimeZone ? <Text style={styles.caption}>個人家事は元の日付で表示しています。地域が異なるため、共有家事の推奨日計算には含めていません。</Text> : null}
    {!overlay.setupCompleted ? <Text style={styles.caption}>個人家事の初期設定を完了すると、ここにも表示されます。</Text>
      : date && date > overlay.generatedThrough ? <Text style={styles.caption}>個人予定の通常生成範囲外です。保存済みの予定だけ表示します。</Text>
        : date && date < overlay.today ? <Text style={styles.caption}>過去の個人家事は、端末に残る予定と実施記録を表示します。</Text> : null}
  </View>;
}

/** The shared actions object is deliberately absent. Only the captured personal source accepts this checkbox. */
export function V2PrivateTaskCard({ row, source, busy, run }: { row: V2PrivateTaskRow; source?: V2PrivateTaskSource; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false); const chore = row.chore;
  return <View style={{ gap: 6 }}>
    <TaskCheckboxRow chore={{ ...chore, category: `個人 · 本人のみ${chore.category ? ` · ${chore.category}` : ''}` }} completed={row.completed}
      deemphasized={row.suggestedDate !== row.date} onOpen={() => setOpen((value) => !value)}
      onToggle={!busy && source ? () => run(() => source.setCompleted(row.key, row.revision, !row.completed)) : undefined} />
    <Text style={styles.caption}>個人の推奨日：{formatJapaneseDate(row.suggestedDate, { weekday: true })}</Text>
    {open ? <Card><V2ChoreProcedures chore={chore} />
      <AppButton title="手順を閉じる" variant="quiet" compact onPress={() => setOpen(false)} />
    </Card> : null}
  </View>;
}
