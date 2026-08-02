import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import { REMINDER_TIME_PRESETS } from '../../constants/onboardingContent';

interface ReminderTimeChipsProps {
  hour: number;
  minute: number;
  onSelect: (hour: number, minute: number) => void;
  /** Light-card style for the light onboarding theme. Defaults to the
   *  translucent-on-dark style used by the settings reminders modal. */
  light?: boolean;
}

// Preset time-of-day chips for the daily reminder — avoids pulling in a native
// time-picker dependency for a single daily-reminder use case.
export function ReminderTimeChips({ hour, minute, onSelect, light = false }: ReminderTimeChipsProps) {
  return (
    <View style={styles.row}>
      {REMINDER_TIME_PRESETS.map((preset) => {
        const isSelected = preset.hour === hour && preset.minute === minute;
        return (
          <Pressable
            key={preset.id}
            style={[
              light ? styles.chipLight : styles.chip,
              isSelected && (light ? styles.chipLightSelected : styles.chipSelected),
            ]}
            onPress={() => { haptic.light(); onSelect(preset.hour, preset.minute); }}
          >
            <Text
              style={[
                light ? styles.chipTextLight : styles.chipText,
                isSelected && (light ? styles.chipTextLightSelected : styles.chipTextSelected),
              ]}
            >
              {preset.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    backgroundColor: 'rgba(255,255,255,0.1)',
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.2)',
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  },
  chipSelected: {
    backgroundColor: '#fff',
    borderColor: '#fff',
  },
  chipText: { fontSize: 13, fontWeight: '600', color: 'rgba(255,255,255,0.8)' },
  chipTextSelected: { color: colors.brand[700] },

  chipLight: {
    backgroundColor: '#fff',
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    paddingHorizontal: spacing.sm,
    paddingVertical: 8,
  },
  chipLightSelected: {
    backgroundColor: colors.brand[600],
    borderColor: colors.brand[600],
  },
  chipTextLight: { fontSize: 13, fontWeight: '600', color: colors.text.secondary },
  chipTextLightSelected: { color: '#fff' },
});
