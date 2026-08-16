import React from 'react';
import { View, Text, StyleSheet, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { spacing, radius } from '../../constants/theme';

/** Matches InlineVideoPlayer's VIDEO_H so the page doesn't reflow between the
 *  sample analysis and a real one. */
const VIDEO_H = Math.round(Dimensions.get('window').height * 0.28);

/**
 * Stands in for the video player on the activation sample analysis.
 *
 * The empty slot is doing real work here: it's the one place in the demo that
 * names what the user is missing by not having recorded yet, at the exact
 * moment they can see what a recording would have bought them.
 */
export function DemoVideoPlaceholder() {
  return (
    <View style={s.wrap}>
      <View style={s.iconRing}>
        <Ionicons name="videocam-outline" size={26} color="rgba(255,255,255,0.75)" />
      </View>
      <Text style={s.title}>Your video will appear here</Text>
      <Text style={s.sub}>
        Record a session and every flagged moment below becomes tappable — it seeks
        straight to the bar where it happened.
      </Text>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    height: VIDEO_H,
    backgroundColor: '#111827',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: spacing.xl,
    gap: spacing.sm,
  },
  iconRing: {
    width: 56,
    height: 56,
    borderRadius: radius.full,
    borderWidth: 1.5,
    borderColor: 'rgba(255,255,255,0.25)',
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: 2,
  },
  title: { color: '#fff', fontSize: 15, fontWeight: '800' },
  sub: {
    color: 'rgba(255,255,255,0.6)',
    fontSize: 12,
    lineHeight: 17,
    textAlign: 'center',
  },
});
