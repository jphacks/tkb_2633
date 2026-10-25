import type { PropsWithChildren, ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

export const palette = {
  background: '#FFFFFF',
  surface: '#FFFFFF',
  ink: '#292C3B',
  muted: '#68718B',
  accent: '#4AADE0',
  accentSoft: '#E4F7FC',
  border: '#DFE4EF',
  warning: '#B75C55',
  warningSoft: '#FBEDEC',
  gold: '#B8873B',
  goldSoft: '#F6F0E3',
};

export function Page({ children, contentStyle }: PropsWithChildren<{ contentStyle?: object }>) {
  return (
    <SafeAreaView style={styles.safeArea} edges={['top']}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={[styles.page, contentStyle]}>
        {children}
      </ScrollView>
    </SafeAreaView>
  );
}

export function ScreenHeading({ eyebrow, title, description }: { eyebrow?: string; title: string; description?: string }) {
  return (
    <View style={styles.heading}>
      {eyebrow ? <Text style={styles.eyebrow}>{eyebrow}</Text> : null}
      <Text style={styles.title}>{title}</Text>
      {description ? <Text style={styles.description}>{description}</Text> : null}
    </View>
  );
}

export function Card({ children, style }: PropsWithChildren<{ style?: object }>) {
  return <View style={[styles.card, style]}>{children}</View>;
}

export function SectionHeading({ title, trailing }: { title: string; trailing?: ReactNode }) {
  return (
    <View style={styles.sectionHeading}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {trailing}
    </View>
  );
}

export function AppButton({
  title,
  onPress,
  variant = 'primary',
  disabled = false,
  compact = false,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'quiet' | 'danger';
  disabled?: boolean;
  compact?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.button,
        compact && styles.buttonCompact,
        styles[`button_${variant}`],
        disabled && styles.buttonDisabled,
        pressed && !disabled && styles.buttonPressed,
      ]}>
      <Text style={[styles.buttonText, styles[`buttonText_${variant}`], compact && styles.buttonTextCompact]}>{title}</Text>
    </Pressable>
  );
}

export function ChoiceChip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected }}
      onPress={onPress}
      style={({ pressed }) => [styles.chip, selected && styles.chipSelected, pressed && styles.buttonPressed]}>
      <Text style={[styles.chipText, selected && styles.chipTextSelected]}>{label}</Text>
    </Pressable>
  );
}

export function StatusBadge({ status }: { status: string }) {
  const label = status === 'overdue'
    ? '超過'
    : status === 'inWindow'
      ? '実施期間中'
      : status === 'initialPending'
        ? '初回の予定'
        : 'これから';
  const isOverdue = status === 'overdue';
  return (
    <View style={[styles.badge, isOverdue && styles.badgeWarning]}>
      <Text style={[styles.badgeText, isOverdue && styles.badgeTextWarning]}>{label}</Text>
    </View>
  );
}

export function MutedText({ children }: PropsWithChildren) {
  return <Text style={styles.mutedText}>{children}</Text>;
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: palette.background },
  page: { width: '100%', maxWidth: 820, alignSelf: 'center', paddingHorizontal: 20, paddingTop: 18, paddingBottom: 36, gap: 15 },
  heading: { gap: 5, marginBottom: 2 },
  eyebrow: { color: palette.accent, fontSize: 14, fontWeight: '700', letterSpacing: 1.4 },
  title: { color: palette.ink, fontSize: 29, fontWeight: '700' },
  description: { color: palette.muted, fontSize: 16, lineHeight: 24 },
  card: { backgroundColor: palette.surface, borderRadius: 16, borderWidth: 1, borderColor: palette.border, padding: 16, gap: 12 },
  sectionHeading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 2 },
  sectionTitle: { color: palette.ink, fontSize: 18, fontWeight: '700' },
  button: { minHeight: 48, borderRadius: 14, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 18, paddingVertical: 10 },
  buttonCompact: { minHeight: 44, paddingHorizontal: 13, paddingVertical: 8, borderRadius: 12 },
  button_primary: { backgroundColor: palette.accent },
  button_secondary: { backgroundColor: palette.accentSoft },
  button_quiet: { backgroundColor: 'transparent' },
  button_danger: { backgroundColor: palette.warningSoft },
  buttonDisabled: { opacity: 0.45 },
  buttonPressed: { opacity: 0.75 },
  buttonText: { fontSize: 17, fontWeight: '700' },
  buttonTextCompact: { fontSize: 15 },
  buttonText_primary: { color: '#FFFFFF' },
  buttonText_secondary: { color: palette.accent },
  buttonText_quiet: { color: palette.muted },
  buttonText_danger: { color: palette.warning },
  chip: { minHeight: 44, borderRadius: 999, borderWidth: 1, borderColor: palette.border, backgroundColor: palette.surface, paddingHorizontal: 14, paddingVertical: 8, alignItems: 'center', justifyContent: 'center' },
  chipSelected: { borderColor: palette.accent, backgroundColor: palette.accentSoft },
  chipText: { color: palette.muted, fontSize: 15, fontWeight: '600' },
  chipTextSelected: { color: palette.accent, fontWeight: '700' },
  badge: { alignSelf: 'flex-start', borderRadius: 999, paddingHorizontal: 9, paddingVertical: 5, backgroundColor: palette.accentSoft },
  badgeWarning: { backgroundColor: palette.warningSoft },
  badgeText: { color: palette.accent, fontSize: 14, fontWeight: '700' },
  badgeTextWarning: { color: palette.warning },
  mutedText: { color: palette.muted, fontSize: 15, lineHeight: 23 },
});
