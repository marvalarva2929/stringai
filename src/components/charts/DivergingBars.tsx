import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import Svg, { Rect, Line } from 'react-native-svg';
import { chart } from './chartTheme';
import { colors, spacing } from '../../constants/theme';
import type { CategoryDelta } from '../../lib/progressAnalytics';

interface DivergingBarsProps {
  deltas: CategoryDelta[];
  width: number;
}

const ROW_H = 26;
const BAR_H = 14;
const LABEL_W = 104;
const VALUE_W = 38;

/**
 * Signed change per category around a zero baseline.
 *
 * The pair is brand blue (gain) against red (loss) rather than the intuitive
 * green/red: validated, green↔red sit only ΔE 4.2 apart under deuteranopia,
 * while blue↔red are 19.4 apart. Every bar also carries a signed number, so the
 * direction survives without colour at all.
 */
export function DivergingBars({ deltas, width }: DivergingBarsProps) {
  if (deltas.length === 0) return null;

  const plotW = Math.max(40, width - LABEL_W - VALUE_W);
  const midX = plotW / 2;
  const maxAbs = Math.max(4, ...deltas.map((d) => Math.abs(d.delta)));
  const scale = (midX - 4) / maxAbs;

  return (
    <View>
      {deltas.map((d) => {
        const magnitude = Math.abs(d.delta) * scale;
        const positive = d.delta >= 0;
        const rounded = Math.round(d.delta);

        return (
          <View key={d.id} style={[styles.row, { height: ROW_H }]}>
            <Text style={[styles.label, { width: LABEL_W }]} numberOfLines={1}>
              {d.label}
            </Text>

            <Svg width={plotW} height={ROW_H}>
              <Line
                x1={midX} y1={2} x2={midX} y2={ROW_H - 2}
                stroke={chart.axis} strokeWidth={1}
              />
              {Math.abs(rounded) > 0 && (
                <Rect
                  // 2px gap from the baseline so the bar never fuses with the axis.
                  x={positive ? midX + 2 : midX - magnitude}
                  y={(ROW_H - BAR_H) / 2}
                  width={Math.max(2, magnitude - 2)}
                  height={BAR_H}
                  rx={4}
                  fill={positive ? chart.positive : chart.negative}
                />
              )}
            </Svg>

            <Text
              style={[
                styles.value,
                { width: VALUE_W, color: rounded === 0 ? chart.neutral : positive ? chart.positive : chart.negative },
              ]}
            >
              {rounded > 0 ? `+${rounded}` : rounded}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  label: { fontSize: 12, color: colors.text.secondary, fontWeight: '600' },
  value: { fontSize: 12, fontWeight: '700', textAlign: 'right' },
});
