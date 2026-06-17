import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { colors } from '../../constants/theme';
import { SeverityBand } from '../../types/analysis';

interface ScoreGaugeProps {
  score: number;
  severity: SeverityBand;
  size?: 'sm' | 'md' | 'lg';
  showLabel?: boolean;
}

const SIZE_MAP = { sm: 52, md: 72, lg: 96 };
const FONT_MAP = { sm: 14, md: 20, lg: 28 };

export function ScoreGauge({ score, severity, size = 'md', showLabel = true }: ScoreGaugeProps) {
  const dim = SIZE_MAP[size];
  const fontSize = FONT_MAP[size];
  const color = colors.score[severity];

  return (
    <View style={[styles.container, { width: dim, height: dim, borderRadius: dim / 2, borderColor: color }]}>
      <Text style={[styles.score, { fontSize, color }]}>{score}</Text>
      {showLabel && <Text style={[styles.label, { color }]}>/100</Text>}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderWidth: 3,
    alignItems: 'center',
    justifyContent: 'center',
  },
  score: { fontWeight: '700', lineHeight: undefined },
  label: { fontSize: 10, fontWeight: '500', marginTop: -2 },
});
