import { useState } from 'react';
import { Text, View } from 'react-native';
import { AppButton, Card, SectionHeading, typography } from '../../../components/planner-ui';
import { TaskCheckboxRow } from '../../../components/task-checkbox-row';
import { formatJapaneseDate } from '../../../domain/scheduling/local-date';
import type { V2PrivateOverlayState, V2PrivateTaskRow, V2PrivateTaskSource } from './private-overlay';

export function V2PrivateTaskNotice({ overlay, sharedTimeZone, date }: { overlay?: V2PrivateOverlayState; sharedTimeZone: string; date?: string }) {
  if (!overlay) return null;
  if (overlay.status === 'unavailable') return <Text accessibilityRole="alert" style={typography.caption}>{overlay.message}</Text>;
  return <View style={{ gap: 4 }}>
    <Text style={typography.caption}>個人家事：本人のみ · {overlay.timeZone}</Text>
    {overlay.timeZone !== sharedTimeZone ? <Text style={typography.caption}>個人家事は元の日付で表示しています。地域が異なるため、共有家事の推奨日計算には含めていません。</Text> : null}
    {!overlay.setupCompleted ? <Text style={typography.caption}>個人家事の初期設定を完了すると、ここにも表示されます。</Text>
      : date && date > overlay.generatedThrough ? <Text style={typography.caption}>個人予定の通常生成範囲外です。保存済みの予定だけ表示します。</Text>
        : date && date < overlay.today ? <Text style={typography.caption}>過去の個人家事は、端末に残る予定と実施記録を表示します。</Text> : null}
  </View>;
}

/** The shared actions object is deliberately absent. Only the captured personal source accepts this checkbox. */
export function V2PrivateTaskCard({ row, source, busy, run }: { row: V2PrivateTaskRow; source?: V2PrivateTaskSource; busy: boolean;
  run: (work: () => Promise<unknown>) => Promise<void> }) {
  const [open, setOpen] = useState(false); const chore = row.chore;
  const sections = chore.procedureSections?.length ? chore.procedureSections : [{ title: '家事の手順', steps: chore.instructions }];
  return <View style={{ gap: 6 }}>
    <TaskCheckboxRow chore={{ ...chore, category: `個人 · 本人のみ${chore.category ? ` · ${chore.category}` : ''}` }} completed={row.completed}
      deemphasized={row.suggestedDate !== row.date} onOpen={() => setOpen((value) => !value)}
      onToggle={!busy && source ? () => run(() => source.setCompleted(row.key, row.revision, !row.completed)) : undefined} />
    <Text style={typography.caption}>個人の推奨日：{formatJapaneseDate(row.suggestedDate, { weekday: true })}</Text>
    {open ? <Card><Text style={typography.body}>{chore.description}</Text>
      {sections.map((section, index) => <View key={index} style={{ gap: 6 }}><SectionHeading title={section.title} level="subsection" />
        {section.steps.map((step, stepIndex) => <Text key={stepIndex} style={typography.body}>{stepIndex + 1}. {step}</Text>)}</View>)}
      {chore.tools.length ? <View><SectionHeading title="使う道具" level="subsection" /><Text style={typography.body}>{chore.tools.join('・')}</Text></View> : null}
      {chore.cautions.length ? <View><SectionHeading title="注意点" level="subsection" />{chore.cautions.map((text, index) => <Text key={index} style={typography.body}>・{text}</Text>)}</View> : null}
      <AppButton title="手順を閉じる" variant="quiet" compact onPress={() => setOpen(false)} />
    </Card> : null}
  </View>;
}
