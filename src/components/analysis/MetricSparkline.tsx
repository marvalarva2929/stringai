import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors, spacing } from '../../constants/theme';
import { severityFromScore } from '../../types/analysis';

interface SparkEntry {
  score: number;
  recordedAt: string;
}

interface MetricSparklineProps {
  data: SparkEntry[];
  barHeight?: number;
}

export function MetricSparkline({ data, barHeight = 56 }: MetricSparklineProps) {
  if (data.length === 0) return null;

  return (
    <View style={styles.container}>
      <View style={[styles.bars, { height: barHeight + 32 }]}>
        {data.map((entry, i) => {
          const fillHeight = Math.max(4, Math.round((entry.score / 100) * barHeight));
          const color = scoreColor(entry.score);
          return (
            <View key={i} style={styles.barCol}>
              <Text style={styles.scoreLabel}>{entry.score}</Text>
              <View style={[styles.track, { height: barHeight }]}>
                <View style={[styles.bar, { height: fillHeight, backgroundColor: color }]} />
              </View>
              <Text style={styles.dateLabel}>{formatDate(entry.recordedAt)}</Text>
            </View>
          );
        })}
      </View>
    </View>
  );
}

function scoreColor(score: number): string {
  const s = severityFromScore(score);
  return colors.score[s];
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

const styles = StyleSheet.create({
  container: { marginTop: spacing.sm },
  bars: { flexDirection: 'row', alignItems: 'flex-end', gap: 6 },
  barCol: { flex: 1, alignItems: 'center', gap: 3 },
  scoreLabel: { fontSize: 10, fontWeight: '700', color: colors.text.secondary },
  track: { width: '100%', justifyContent: 'flex-end', backgroundColor: '#f0eeff', borderRadius: 3 },
  bar: { width: '100%', borderRadius: 3 },
  dateLabel: { fontSize: 9, color: colors.text.muted, marginTop: 2 },
});
