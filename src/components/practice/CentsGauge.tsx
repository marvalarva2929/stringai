import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Animated, { useAnimatedStyle, type SharedValue } from 'react-native-reanimated';
import { colors, spacing } from '../../constants/theme';

/**
 * Green band when no tolerance is supplied — the tuner's standard, where the
 * player is deliberately chasing dead centre rather than clearing a drill's bar.
 */
const DEFAULT_GREEN_CENTS = 8;
/** How far past the green band amber runs before a reading counts as a miss. */
const AMBER_MARGIN_CENTS = 12;

/**
 * Colour for a cents reading.
 *
 * `toleranceCents` should be the drill's actual pass tolerance (exercises/types
 * centsFor: 15/20/25). Without it the gauge showed green only inside 8¢ while
 * the grader was passing notes at 20¢ — so a note the app had just accepted
 * still looked wrong on screen. Anything judging a take should pass its bar in.
 */
export function noteColor(cents: number, toleranceCents?: number): string {
  const green = toleranceCents ?? DEFAULT_GREEN_CENTS;
  const abs = Math.abs(cents);
  if (abs <= green) return colors.score.excellent;
  if (abs <= green + AMBER_MARGIN_CENTS) return '#f59e0b';
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
  /**
   * The drill's pass tolerance. Widens the green band and the needle colour to
   * match, so the gauge shows the bar the take is actually judged against
   * rather than a fixed 8¢ the grader stopped using.
   */
  toleranceCents?: number;
}

/** Horizontal cents-off-pitch gauge, ±50¢ range. Extracted from the tuner so exercise screens can reuse it. */
export function CentsGauge({ cents, active, centsSv, toleranceCents }: CentsGaugeProps) {
  const clamped = Math.max(-50, Math.min(50, cents));
  const needlePercent = ((clamped + 50) / 100) * 100;
  const color = noteColor(clamped, toleranceCents);
  // The gauge spans ±50¢, so a tolerance of N¢ is N% in from each edge of centre.
  const greenInset = `${50 - Math.max(0, Math.min(50, toleranceCents ?? DEFAULT_GREEN_CENTS))}%`;

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
        <View style={[s.greenZone, { left: greenInset as any, right: greenInset as any }]} />
        {active && (
          centsSv
            ? <AnimatedNeedle centsSv={centsSv} greenCents={toleranceCents ?? DEFAULT_GREEN_CENTS} />
            : <View style={[s.needle, { left: `${needlePercent}%` as any, backgroundColor: color }]} />
        )}
      </View>

      <Text style={s.centsLabel}>cents</Text>
    </View>
  );
}

// Colour thresholds are passed in as plain numbers rather than read from the
// component scope: this runs as a worklet on the UI thread.
function AnimatedNeedle({ centsSv, greenCents }: { centsSv: SharedValue<number>; greenCents: number }) {
  const amberCents = greenCents + AMBER_MARGIN_CENTS;
  const style = useAnimatedStyle(() => {
    const c = Math.max(-50, Math.min(50, centsSv.value));
    const abs = Math.abs(c);
    return {
      // Track is 100% wide and the ±50¢ range maps onto it linearly, so left% === c + 50.
      left: `${c + 50}%`,
      backgroundColor:
        abs <= greenCents ? colors.score.excellent
          : abs <= amberCents ? '#f59e0b'
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
