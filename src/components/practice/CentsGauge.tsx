import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { colors, spacing } from '../../constants/theme';

const GREEN_CENTS = 8;
const AMBER_CENTS = 20;

export function noteColor(cents: number): string {
  const abs = Math.abs(cents);
  if (abs <= GREEN_CENTS) return colors.score.excellent;
  if (abs <= AMBER_CENTS) return '#f59e0b';
  return colors.score.critical;
}

interface CentsGaugeProps {
  cents: number;
  active: boolean;
  /**
   * Optional live cents channel. When supplied the needle is animated on the UI thread
   * from this value and `cents` is ignored — lets the tuner push ~47 readings/sec without
   * re-rendering React on every one.
   */
  centsSv?: SharedValue<number>;
}

/** Horizontal cents-off-pitch gauge, ±50¢ range. Extracted from the tuner so exercise screens can reuse it. */
export function CentsGauge({ cents, active, centsSv }: CentsGaugeProps) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const needlePercent = ((clamped + 50) / 100) * 100;
  const color = noteColor(clamped);

  return (
    <View style={s.wrap}>
      <View style={s.ticks}>
        {[-50, -25, 0, 25, 50].map((v) => (
          <View key={v} style={s.tickCol}>
            <View style={[s.tick, v === 0 && s.tickCenter]} />
            <Text style={[s.tickLabel, v === 0 && s.tickLabelCenter]}>{v}</Text>
          </View>
        ))}
      </View>

      <View style={s.track}>
        <View style={s.greenZone} />
        {active && (
          centsSv
            ? <AnimatedNeedle centsSv={centsSv} />
            : <View style={[s.needle, { left: `${needlePercent}%` as any, backgroundColor: color }]} />
        )}
      </View>

      <Text style={s.centsLabel}>cents</Text>
    </View>
  );
}

function AnimatedNeedle({ centsSv }: { centsSv: SharedValue<number> }) {
  const style = useAnimatedStyle(() => {
    const c = Math.max(-50, Math.min(50, centsSv.value));
    const abs = Math.abs(c);
    return {
      // Track is 100% wide and the ±50¢ range maps onto it linearly, so left% === c + 50.
      left: `${c + 50}%`,
      backgroundColor:
        abs <= GREEN_CENTS ? colors.score.excellent
          : abs <= AMBER_CENTS ? '#f59e0b'
            : colors.score.critical,
    };
  });

  return <Animated.View style={[s.needle, style]} />;
}

const s = StyleSheet.create({
  wrap: { paddingHorizontal: spacing.xl, marginTop: spacing.sm },
  ticks: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 4 },
  tickCol: { alignItems: 'center', width: 28 },
  tick: { width: 1, height: 8, backgroundColor: '#d1d5db' },
  tickCenter: { height: 12, backgroundColor: '#9ca3af' },
  tickLabel: { fontSize: 9, color: colors.text.muted, marginTop: 2 },
  tickLabelCenter: { fontWeight: '700', color: colors.text.secondary },
  track: {
    height: 20,
    backgroundColor: '#f3f4f6',
    borderRadius: 10,
    overflow: 'hidden',
    position: 'relative',
    justifyContent: 'center',
  },
  greenZone: {
    position: 'absolute',
    left: '42%',
    right: '42%',
    top: 0,
    bottom: 0,
    backgroundColor: '#dcfce7',
  },
  needle: {
    position: 'absolute',
    width: 3,
    top: 2,
    bottom: 2,
    borderRadius: 2,
    transform: [{ translateX: -1.5 }],
  },
  centsLabel: {
    textAlign: 'center',
    fontSize: 11,
    color: colors.text.muted,
    marginTop: spacing.xs,
  },
});
