import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { spacing, colors } from '../../constants/theme';
import {
  HANDEDNESS_OPTIONS,
  FOCUS_OPTIONS,
  STEP_COPY,
} from '../../constants/onboardingContent';
import { useOnboardingStore, Handedness, FocusPreference } from '../../store/useOnboardingStore';
import { OptionCards } from './OptionCards';

// Two small icon grids (handedness, focus) on one screen — each set is short
// enough that stacking them still fits without scrolling.
export function PreferencesStep() {
  const insets = useSafeAreaInsets();
  const { handedness, setHandedness, focusPreference, setFocusPreference } = useOnboardingStore();

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.xl }]}>
      <Text style={styles.title}>{STEP_COPY.preferences.title}</Text>
      <Text style={styles.subtitle}>{STEP_COPY.preferences.subtitle}</Text>

      <Text style={styles.sectionTitle}>Handedness</Text>
      <OptionCards
        options={HANDEDNESS_OPTIONS}
        selectedIds={[handedness]}
        onToggle={(id) => setHandedness(id as Handedness)}
      />

      <Text style={styles.sectionTitle}>What do you want to focus on?</Text>
      <OptionCards
        options={FOCUS_OPTIONS}
        selectedIds={[focusPreference]}
        onToggle={(id) => setFocusPreference(id as FocusPreference)}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, paddingHorizontal: spacing.xl, gap: spacing.sm },
  title: {
    fontSize: 22,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginBottom: 2,
  },
  subtitle: {
    fontSize: 13,
    color: colors.text.secondary,
    textAlign: 'center',
    lineHeight: 18,
    marginBottom: spacing.xs,
  },
  sectionTitle: {
    fontSize: 16,
    fontWeight: '700',
    color: colors.text.primary,
    textAlign: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.xs,
  },
});
