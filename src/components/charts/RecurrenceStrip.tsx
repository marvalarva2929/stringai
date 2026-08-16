import React from 'react';
import { View, StyleSheet } from 'react-native';
import { chart } from './chartTheme';

interface RecurrenceStripProps {
  /** Oldest-first: was the issue present in each session? */
  presence: boolean[];
  size?: number;
}

/**
 * Per-session presence of one issue, oldest on the left.
 *
 * Filled vs hollow is the primary encoding — the colour is secondary, so this
 * survives being printed, screenshotted in greyscale, or read with any form of
 * colour blindness. Reading left to right, a cluster of fills at the right edge
 * says "getting worse" and a run of hollows says "fading", without a label
 * having to say so.
 */
export function RecurrenceStrip({ presence, size = 9 }: RecurrenceStripProps) {
  return (
    <View style={styles.row}>
      {presence.map((present, i) => (
        <View
          key={i}
          style={[
            styles.dot,
            {
              width: size,
              height: size,
              borderRadius: size / 2,
              backgroundColor: present ? chart.present : 'transparent',
              borderColor: present ? chart.present : chart.absent,
            },
          ]}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 4 },
  dot: { borderWidth: 1.5 },
});
