import { Text } from 'react-native';
import type { DesignationMode } from '../v2/model';
import { V2TextField, V2TimeDisambiguation, v2FormStyles as styles } from './form-controls';
import type { V2TargetFields } from './target-form';

/** One set of labels, interval requirements and DST choices for both date-entry flows. */
export function V2DateTargetFields({ mode, fields, timeZone, disabled, onChange }: {
  mode: DesignationMode; fields: V2TargetFields; timeZone: string; disabled: boolean;
  onChange: (name: keyof V2TargetFields, value: string) => void;
}) {
  return <><V2TextField label={mode === 'deadline' ? '期限の日付' : '実施日'} value={fields.day} placeholder="YYYY-MM-DD" editable={!disabled} onChangeText={(value) => onChange('day', value)} />
    {mode !== 'day' ? <><V2TextField label={mode === 'fixed' ? '開始時刻' : '期限の時刻（任意）'} value={fields.clock} placeholder="HH:mm" editable={!disabled} onChangeText={(value) => onChange('clock', value)} />
      <V2TimeDisambiguation day={fields.day} clock={fields.clock} timeZone={timeZone} value={fields.clockChoice} disabled={disabled} onChange={(value) => onChange('clockChoice', value)} />
      {mode === 'deadline' ? <Text style={styles.caption}>時刻を空欄にすると、この地域の23:59を申請期限の計算に使います。</Text> : null}</> : null}
    {mode === 'fixed' ? <><V2TextField label="終了日" value={fields.endDay} placeholder="YYYY-MM-DD" editable={!disabled} onChangeText={(value) => onChange('endDay', value)} />
      <V2TextField label="終了時刻" value={fields.endClock} placeholder="HH:mm" editable={!disabled} onChangeText={(value) => onChange('endClock', value)} />
      <V2TimeDisambiguation label="終了時刻の区別" day={fields.endDay} clock={fields.endClock} timeZone={timeZone} value={fields.endClockChoice} disabled={disabled} onChange={(value) => onChange('endClockChoice', value)} /></> : null}
  </>;
}
