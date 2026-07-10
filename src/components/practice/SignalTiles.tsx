import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { LiveSignal } from '../../lib/practiceBlocks';
import { signalIcon } from '../../lib/practiceCopy';
import { colors, radius, spacing } from '../../constants/theme';

/** Row of pill tiles naming the live signals a block listens to (mic, camera, …). */
export function SignalTiles({ signals }: { signals: LiveSignal[] }) {
  if (signals.length === 0) return null;
  return (
    <View style={s.grid}>
      {signals.map((signal) => (
        <View key={signal} style={s.tile}>
          <Ionicons name={signalIcon(signal)} size={16} color={colors.brand[700]} />
          <Text style={s.text}>{signal}</Text>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  tile: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: '#fff',
    borderRadius: radius.full,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
  },
  text: { color: colors.brand[700], fontSize: 12, fontWeight: '900', textTransform: 'capitalize' },
});
