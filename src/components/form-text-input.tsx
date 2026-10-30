import { StyleSheet, TextInput } from 'react-native';
import type { TextInputProps } from 'react-native';
import { typography } from './planner-typography';

/** Native editable text uses font metrics rather than paragraph line spacing. */
export function FormTextInput({ style, multiline = false, ...props }: TextInputProps) {
  return <TextInput {...props} multiline={multiline} underlineColorAndroid="transparent"
    style={[styles.base, style, { lineHeight: undefined, includeFontPadding: false, textAlignVertical: multiline ? 'top' : 'center' }]} />;
}
const styles = StyleSheet.create({ base: { fontSize: typography.body.fontSize, minHeight: 48, paddingVertical: 10 } });
