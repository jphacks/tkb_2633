import type { ReactNode } from 'react';
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';
import type { StyleProp, TextInputProps, ViewStyle } from 'react-native';
import { palette, typography } from '../../../components/planner-ui';

/** Android already uses adjustResize. Avoid applying an additional keyboard-height correction there. */
export function V2FormScrollView({ children, contentContainerStyle }: { children: ReactNode; contentContainerStyle?: StyleProp<ViewStyle> }) {
  return <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={contentContainerStyle}>{children}</ScrollView>
  </KeyboardAvoidingView>;
}

export function V2Choices<T extends string>({ label, value, choices, onChange, disabled = false }: {
  label: string; value: T; choices: readonly { value: T; label: string }[]; onChange: (value: T) => void; disabled?: boolean;
}) {
  return <View style={v2FormStyles.group}><Text style={v2FormStyles.label}>{label}</Text><View style={v2FormStyles.choices}>
    {choices.map((choice) => <Pressable key={choice.value} accessibilityRole="radio" accessibilityLabel={choice.label}
      accessibilityState={{ checked: value === choice.value, disabled }} disabled={disabled} onPress={() => onChange(choice.value)}
      style={[v2FormStyles.choice, value === choice.value && v2FormStyles.selectedChoice, disabled && v2FormStyles.disabled]}>
      <Text style={v2FormStyles.choiceText}>{choice.label}</Text>
    </Pressable>)}
  </View></View>;
}

export function V2TextField({ label, ...props }: Omit<TextInputProps, 'style' | 'accessibilityLabel'> & { label: string }) {
  return <View style={v2FormStyles.group}><Text style={v2FormStyles.label}>{label}</Text>
    <TextInput {...props} accessibilityLabel={label} autoCapitalize="none" style={v2FormStyles.input} />
  </View>;
}

export const v2FormStyles = StyleSheet.create({
  group: { gap: 6 }, choices: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  choice: { minHeight: 44, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, borderWidth: 1, borderColor: palette.border, justifyContent: 'center' },
  selectedChoice: { backgroundColor: palette.accentSoft, borderColor: palette.accent }, disabled: { opacity: 0.5 },
  choiceText: { ...typography.label, color: palette.ink }, label: { ...typography.label, color: palette.ink },
  input: { ...typography.body, color: palette.ink, minHeight: 46, borderWidth: 1, borderColor: palette.border, borderRadius: 11, paddingHorizontal: 12 },
  body: { ...typography.body, color: palette.ink }, caption: { ...typography.caption, color: palette.muted },
  error: { ...typography.caption, color: palette.warning },
});
