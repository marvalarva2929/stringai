import React, { useEffect } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { useSharedValue, useAnimatedStyle, withTiming } from 'react-native-reanimated';
import { colors } from '../../constants/theme';

/**
 * The metronome's visual beat: a bar that flashes across the top edge of the
 * recording screen, thicker and brighter on the downbeat.
 *
 * It exists because the click alone isn't always enough — the player may have
 * the sound off (it bleeds into the recorded audio), or simply be drowning it
 * out. A bar at the frame edge is caught by peripheral vision, so the beat can
 * be followed without looking away from the bow.
 */
export function MetronomeBeatBar({ beat, beatInBar }: { beat: number; beatInBar: number }) {
  const flash = useSharedValue(0);
  const downbeat = beatInBar === 0;

  useEffect(() => {
    if (beat < 0) return;
    flash.value = 1;
    flash.value = withTiming(0, { duration: 260 });
  }, [beat, flash]);

  const style = useAnimatedStyle(() => ({ opacity: flash.value }));

  if (beat < 0) return null;

  return (
    <Animated.View
      style={[s.bar, downbeat ? s.downbeat : s.offbeat, style]}
      pointerEvents="none"
    />
  );
}

const s = StyleSheet.create({
  bar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
  },
  offbeat: { height: 3, backgroundColor: 'rgba(255,255,255,0.55)' },
  downbeat: { height: 6, backgroundColor: colors.brand[400] },
});
