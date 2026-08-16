import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Sparkline } from '../charts/Sparkline';
import { DIRECTION_STYLE } from '../charts/chartTheme';
import { colors, spacing } from '../../constants/theme';
import { haptic } from '../../lib/haptics';
import type { CategorySeries } from '../../lib/progressAnalytics';

interface CategoryTrendRowProps {
  series: CategorySeries;
  /** Suppresses the direction chip when there isn't enough history to trust it. */
  earlyData?: boolean;
  onPress?: () => void;
}

/**
 * One category's trend: name, shape, current value, direction.
 *
 * The value is a real measured figure where one honestly exists (see
 * CATEGORY_UNITS) and a plain-language band otherwise — never a percentage
 * back-computed from the internal score.
 */
export function CategoryTrendRow({ series, earlyData = false, onPress }: CategoryTrendRowProps) {
  const direction = DIRECTION_STYLE[series.direction];
  const showChip = series.measured && series.direction !== 'unknown' && !earlyData;

  const valueText = series.measured
    ? series.headlineText ?? series.bandText ?? '—'
    : 'not measured yet';

  const body = (
    <View style={s.row}>
      <Text style={[s.label, !series.measured && s.dim]} numberOfLines={1}>
        {series.label}
      </Text>

      <Sparkline points={series.points} empty={!series.measured} />

      <View style={s.valueBlock}>
        <Text style={[s.value, !series.measured && s.dim]} numberOfLines={1}>
          {valueText}
        </Text>
        {showChip ? (
          <Text style={[s.chip, { color: direction.color }]} numberOfLines={1}>
            {direction.glyph} {direction.label}
          </Text>
        ) : earlyData && series.measured ? (
          <Text style={s.chipMuted}>early</Text>
        ) : null}
      </View>
    </View>
  );

  if (!onPress || !series.measured) {
    return <View style={s.wrap}>{body}</View>;
  }

  return (
    <Pressable
      style={({ pressed }) => [s.wrap, pressed && s.pressed]}
      onPress={() => { haptic.light(); onPress(); }}
    >
      {body}
    </Pressable>
  );
}

const s = StyleSheet.create({
  wrap: {
    paddingVertical: spacing.sm,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: '#eef0f3',
  },
  pressed: { backgroundColor: '#f9fafb' },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  label: { flex: 1, fontSize: 13, fontWeight: '600', color: colors.text.primary },
  valueBlock: { width: 116, alignItems: 'flex-end' },
  value: { fontSize: 12, fontWeight: '700', color: colors.text.primary },
  chip: { fontSize: 11, fontWeight: '600', marginTop: 1 },
  chipMuted: { fontSize: 11, color: colors.text.muted, marginTop: 1 },
  dim: { color: colors.text.muted, fontWeight: '500' },
});
