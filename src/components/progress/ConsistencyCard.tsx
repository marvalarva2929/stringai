import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { FontAwesome6 } from '@expo/vector-icons';
import { PracticeHeatmap } from '../charts/PracticeHeatmap';
import { DepthCard } from '../ui/DepthCard';
import { colors, spacing, radius } from '../../constants/theme';
import type { CalendarDay } from '../../lib/progressAnalytics';

interface ConsistencyCardProps {
  weeks: CalendarDay[][];
  streak: number;
  minutesThisWeek: number;
  goalMinutes: number | null;
  onPress?: () => void;
}

const CARD_PADDING = spacing.md;
const SCREEN_PADDING = spacing.lg;

export function ConsistencyCard({
  weeks, streak, minutesThisWeek, goalMinutes, onPress,
}: ConsistencyCardProps) {
  const { width } = useWindowDimensions();
  const chartWidth = width - SCREEN_PADDING * 2 - CARD_PADDING * 2 - 3;

  const pct = goalMinutes ? Math.min(100, (minutesThisWeek / goalMinutes) * 100) : 0;
  const goalMet = goalMinutes != null && minutesThisWeek >= goalMinutes;

  return (
    <DepthCard onPress={onPress}>
      <View style={s.headerRow}>
        <FontAwesome6 name="fire" size={15} color="#f97316" />
        <Text style={s.streak}>
          {streak === 0 ? 'No active streak' : `${streak} day${streak === 1 ? '' : 's'} in a row`}
        </Text>
        {goalMinutes != null && (
          <Text style={s.goalLabel}>
            {minutesThisWeek} / {goalMinutes} min
          </Text>
        )}
      </View>

      {goalMinutes != null && (
        <View style={s.track}>
          <View
            style={[s.fill, { width: `${pct}%`, backgroundColor: goalMet ? '#22c55e' : colors.brand[600] }]}
          />
        </View>
      )}

      <PracticeHeatmap weeks={weeks} width={chartWidth} />
    </DepthCard>
  );
}

const s = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  streak: { flex: 1, fontSize: 14, fontWeight: '700', color: colors.text.primary },
  goalLabel: { fontSize: 12, fontWeight: '700', color: colors.brand[600] },
  track: {
    height: 8,
    borderRadius: radius.full,
    backgroundColor: colors.brand[100],
    overflow: 'hidden',
  },
  fill: { height: '100%', borderRadius: radius.full },
});
