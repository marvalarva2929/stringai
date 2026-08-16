import React from 'react';
import { View, Text, StyleSheet, useWindowDimensions } from 'react-native';
import { TrendLine } from '../charts/TrendLine';
import { DIRECTION_STYLE } from '../charts/chartTheme';
import { DepthCard } from '../ui/DepthCard';
import { colors, spacing } from '../../constants/theme';
import type { PeriodComparison, TrendPoint, ProgressRange } from '../../lib/progressAnalytics';
import { RANGE_LABELS } from '../../lib/progressAnalytics';

interface OverallTrendCardProps {
  points: TrendPoint[];
  comparison: PeriodComparison;
  range: ProgressRange;
  onPointPress?: (point: TrendPoint) => void;
}

const CARD_PADDING = spacing.md;
const SCREEN_PADDING = spacing.lg;

export function OverallTrendCard({ points, comparison, range, onPointPress }: OverallTrendCardProps) {
  const { width } = useWindowDimensions();
  const chartWidth = width - SCREEN_PADDING * 2 - CARD_PADDING * 2 - 3; // 3 = card border

  const current = comparison.current != null ? Math.round(comparison.current) : null;
  const delta = comparison.delta != null ? Math.round(comparison.delta) : null;
  const direction = DIRECTION_STYLE[comparison.direction];

  const periodWord = range === 'all' ? 'all time' : `in the last ${RANGE_LABELS[range].toLowerCase()}`;

  return (
    <DepthCard>
      <View style={s.headerRow}>
        <View>
          <Text style={s.value}>{current ?? '—'}</Text>
          <Text style={s.label}>Overall {periodWord}</Text>
        </View>

        {delta != null && comparison.direction !== 'unknown' && (
          <View style={s.deltaBlock}>
            <Text style={[s.delta, { color: direction.color }]}>
              {direction.glyph} {delta > 0 ? `+${delta}` : delta}
            </Text>
            <Text style={s.deltaLabel}>
              vs. {Math.round(comparison.previous!)} before that
            </Text>
          </View>
        )}
      </View>

      {points.length >= 2 ? (
        <TrendLine
          points={points}
          width={chartWidth}
          onPointPress={onPointPress ? (p) => onPointPress(p) : undefined}
        />
      ) : (
        <Text style={s.hint}>
          Record another session to see this as a trend.
        </Text>
      )}

      {/* The overall number is a weighted blend that excludes the metrics still
          being calibrated — say so rather than letting it read as everything. */}
      <Text style={s.footnote}>
        Blends your sound metrics — intonation, tone, rhythm and vibrato — weighted
        for your level. Bow and posture are tracked separately below.
      </Text>
    </DepthCard>
  );
}

const s = StyleSheet.create({
  headerRow: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  value: { fontSize: 34, fontWeight: '800', color: colors.text.primary, lineHeight: 38 },
  label: { fontSize: 12, color: colors.text.muted, fontWeight: '600' },
  deltaBlock: { alignItems: 'flex-end' },
  delta: { fontSize: 17, fontWeight: '800' },
  deltaLabel: { fontSize: 11, color: colors.text.muted, marginTop: 2 },
  hint: { fontSize: 13, color: colors.text.secondary, paddingVertical: spacing.md },
  footnote: { fontSize: 11, color: colors.text.muted, lineHeight: 16 },
});
