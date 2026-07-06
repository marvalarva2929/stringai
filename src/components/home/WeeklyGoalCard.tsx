import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { colors, spacing, radius } from '../../constants/theme';
import { haptic } from '../../lib/haptics';

const GOAL_MET_COLOR = '#22c55e';

interface WeeklyGoalCardProps {
  goalMinutes: number | null;
  minutesThisWeek: number;
  onPress: () => void;
}

export function WeeklyGoalCard({ goalMinutes, minutesThisWeek, onPress }: WeeklyGoalCardProps) {
  const handlePress = () => { haptic.light(); onPress(); };

  if (goalMinutes == null) {
    return (
      <Pressable style={({ pressed }) => [s.card, pressed && s.cardPressed]} onPress={handlePress}>
        <View style={s.headerRow}>
          <View style={s.iconCircle}>
            <FontAwesome6 name="bullseye" size={16} color={colors.brand[600]} />
          </View>
          <Text style={s.ctaText}>Set a weekly practice goal</Text>
          <Text style={s.chevron}>›</Text>
        </View>
      </Pressable>
    );
  }

  const pct = Math.min(100, (minutesThisWeek / goalMinutes) * 100);
  const goalMet = minutesThisWeek >= goalMinutes;
  const statusText = goalMet
    ? 'Goal met — amazing work! 🎉'
    : minutesThisWeek === 0
    ? 'Record a session to get started!'
    : `${minutesThisWeek} of ${goalMinutes} min — keep it up!`;

  return (
    <Pressable style={({ pressed }) => [s.card, pressed && s.cardPressed]} onPress={handlePress}>
      <View style={s.headerRow}>
        <View style={s.iconCircle}>
          <FontAwesome6 name="bullseye" size={16} color={colors.brand[600]} />
        </View>
        <Text style={s.title}>Weekly Goal</Text>
        <Text style={s.progressLabel}>
          {minutesThisWeek} / {goalMinutes} min
        </Text>
      </View>
      <View style={s.track}>
        <View
          style={[
            s.fill,
            { width: `${pct}%`, backgroundColor: goalMet ? GOAL_MET_COLOR : colors.brand[600] },
          ]}
        />
      </View>
      <Text style={s.statusText}>{statusText}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  card: {
    backgroundColor: '#fff',
    borderRadius: 16,
    borderWidth: 1.5,
    borderColor: '#e5e7eb',
    borderBottomWidth: 4,
    borderBottomColor: '#d1d5db',
    padding: spacing.md,
    gap: spacing.sm,
  },
  cardPressed: {
    backgroundColor: '#f9fafb',
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
  },
  iconCircle: {
    width: 32,
    height: 32,
    borderRadius: 16,
    backgroundColor: colors.brand[100],
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  progressLabel: {
    fontSize: 14,
    fontWeight: '800',
    color: colors.brand[600],
  },
  ctaText: {
    flex: 1,
    fontSize: 15,
    fontWeight: '700',
    color: colors.text.primary,
  },
  chevron: {
    fontSize: 20,
    color: colors.text.muted,
    fontWeight: '300',
  },
  track: {
    height: 10,
    borderRadius: radius.full,
    backgroundColor: colors.brand[100],
    overflow: 'hidden',
  },
  fill: {
    height: '100%',
    borderRadius: radius.full,
  },
  statusText: {
    fontSize: 12,
    color: colors.text.muted,
    fontWeight: '500',
  },
});
