import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Sparkline } from '../charts/Sparkline';
import { DIRECTION_STYLE } from '../charts/chartTheme';
import { DepthCard } from '../ui/DepthCard';
import { colors, spacing } from '../../constants/theme';
import type { TrendPoint, TrendDirection } from '../../lib/progressAnalytics';

export interface PieceSummary {
  pieceId: string | null;
  title: string;
  composer?: string;
  sessionCount: number;
  points: TrendPoint[];
  direction: TrendDirection;
  /** The one thing worth saying about this piece, e.g. "2 issues only show up here". */
  note: string | null;
}

interface PieceSummaryCardProps {
  summary: PieceSummary;
  onPress: () => void;
}

export function PieceSummaryCard({ summary, onPress }: PieceSummaryCardProps) {
  const direction = DIRECTION_STYLE[summary.direction];
  const sub = summary.pieceId === null
    ? `${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'} without a piece selected`
    : [summary.composer, `${summary.sessionCount} session${summary.sessionCount === 1 ? '' : 's'}`]
        .filter(Boolean).join(' · ');

  return (
    <DepthCard onPress={onPress} style={s.card}>
      <View style={s.topRow}>
        <View style={s.titleBlock}>
          <Text style={s.title} numberOfLines={1}>{summary.title}</Text>
          <Text style={s.sub} numberOfLines={1}>{sub}</Text>
        </View>
        <Sparkline points={summary.points} empty={summary.points.length === 0} />
        <Text style={s.chevron}>›</Text>
      </View>

      <View style={s.bottomRow}>
        {summary.direction !== 'unknown' && (
          <Text style={[s.chip, { color: direction.color }]}>
            {direction.glyph} {direction.label}
          </Text>
        )}
        {summary.note && <Text style={s.note} numberOfLines={1}>{summary.note}</Text>}
      </View>
    </DepthCard>
  );
}

const s = StyleSheet.create({
  card: { gap: spacing.xs },
  topRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  titleBlock: { flex: 1 },
  title: { fontSize: 15, fontWeight: '700', color: colors.text.primary },
  sub: { fontSize: 12, color: colors.text.muted, marginTop: 2 },
  chevron: { fontSize: 20, color: colors.text.muted, fontWeight: '300' },
  bottomRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  chip: { fontSize: 11, fontWeight: '700' },
  note: { flex: 1, fontSize: 11, color: colors.text.secondary },
});
