import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Text as SvgText } from 'react-native-svg';
import { chart, heatColor } from './chartTheme';
import { colors, spacing } from '../../constants/theme';
import type { CalendarDay } from '../../lib/progressAnalytics';

interface PracticeHeatmapProps {
  /** Monday-first weeks, oldest first. */
  weeks: CalendarDay[][];
  width: number;
}

const GAP = 3;
const DAY_LABELS = ['M', 'T', 'W', 'T', 'F', 'S', 'S'];
const LABEL_W = 14;

/** Minutes at which a day reaches the darkest step. Keyed to the app's own goal
 *  tiers (15–120 min a week, i.e. ~2–20 a day) so an ordinary recorded session
 *  reads as a solid day rather than washing out against one marathon. */
const SATURATION_MINUTES = 10;

/**
 * Day-cell calendar. Sequential single hue, light → dark, which is the correct
 * encoding for a magnitude — a rainbow here would imply categories that don't
 * exist. Rest days render as an explicit empty cell rather than a gap, because
 * the shape of the gaps is the thing worth seeing.
 */
export function PracticeHeatmap({ weeks, width }: PracticeHeatmapProps) {
  if (weeks.length === 0) return null;

  const cols = weeks.length;
  const available = width - LABEL_W;
  // Capped as well as floored: at a 4-week range the cells would otherwise
  // stretch to ~60px each and the grid would be taller than the screen.
  const cell = Math.min(18, Math.max(8, Math.floor((available - GAP * (cols - 1)) / cols)));
  const svgW = LABEL_W + cols * cell + (cols - 1) * GAP;
  const svgH = 7 * cell + 6 * GAP;

  return (
    <View style={styles.wrap}>
      {/* Centred: at the 4-week range there are only five columns, and a capped
          cell size would otherwise leave the grid hugging the card's left edge. */}
      <Svg width={svgW} height={svgH}>
        {/* Alternate rows only — seven single letters stacked is noise. */}
        {DAY_LABELS.map((label, row) =>
          row % 2 === 0 ? (
            <SvgText
              key={`label-${row}`}
              x={0}
              y={row * (cell + GAP) + cell / 2 + 3}
              fontSize={9}
              fill={colors.text.muted}
            >
              {label}
            </SvgText>
          ) : null,
        )}
        {weeks.map((days, col) =>
          days.map((day, row) => {
            const x = LABEL_W + col * (cell + GAP);
            const y = row * (cell + GAP);
            const intensity = Math.min(1, day.minutes / SATURATION_MINUTES);
            return (
              <Rect
                key={`${col}-${row}`}
                x={x}
                y={y}
                width={cell}
                height={cell}
                rx={3}
                fill={day.isFuture ? chart.surface : heatColor(intensity)}
                stroke={day.isFuture ? chart.grid : 'none'}
                strokeWidth={day.isFuture ? 1 : 0}
              />
            );
          }),
        )}
      </Svg>

      <View style={styles.legendRow}>
        <Text style={styles.legendLabel}>Less</Text>
        <View style={styles.legendSwatches}>
          {chart.heat.map((c) => (
            <View key={c} style={[styles.swatch, { backgroundColor: c }]} />
          ))}
        </View>
        <Text style={styles.legendLabel}>More</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { alignItems: 'center' },
  legendRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    marginTop: spacing.sm,
  },
  legendLabel: { fontSize: 10, color: colors.text.muted },
  legendSwatches: { flexDirection: 'row', gap: 2 },
  swatch: { width: 10, height: 10, borderRadius: 2 },
});
