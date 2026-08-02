import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import Animated, { FadeInDown, FadeOut } from 'react-native-reanimated';
import { colors, radius, spacing } from '../../constants/theme';
import type { LiveCue, CueKind } from '../../lib/liveCoach';

/**
 * The single live coaching cue shown over the recording camera.
 *
 * Every decision here follows from the viewing situation: the player is roughly
 * two metres away, holding a violin, mid-stroke, and cannot touch the phone.
 *
 *   • One cue, one line, ~34pt. The previous attempt at live feedback failed
 *     mainly because the text was too small to read from playing distance.
 *   • Colour carries the meaning — green praise, amber fix, red setup — so the
 *     banner can be understood peripherally without reading it at all.
 *   • Anchored top-centre: the player's body sits in the middle of frame and the
 *     stop button in the bottom corner, so the top strip is the only place that
 *     blocks neither.
 *   • pointerEvents none, always. Nothing here is tappable during a take.
 */

const KIND_COLOR: Record<CueKind, string> = {
  praise: colors.score.excellent,
  fix: colors.score.needs_attention,
  setup: colors.score.critical,
};

export function LiveCoachBanner({ cue }: { cue: LiveCue | null }) {
  if (!cue) return null;
  const accent = KIND_COLOR[cue.kind];

  return (
    <View style={s.wrap} pointerEvents="none">
      <Animated.View
        // Keyed by cue id so a new cue replays the entrance rather than
        // silently swapping its text, which reads as a glitch at a glance.
        key={cue.id}
        entering={FadeInDown.duration(180)}
        exiting={FadeOut.duration(220)}
        style={[s.pill, { borderColor: accent }]}
      >
        <View style={[s.iconCircle, { backgroundColor: accent }]}>
          <Ionicons name={cue.icon as any} size={26} color="#000" />
        </View>
        <View style={s.textCol}>
          <Text style={s.headline} numberOfLines={1} adjustsFontSizeToFit minimumFontScale={0.7}>
            {cue.headline}
          </Text>
          {cue.sub && (
            <Text style={s.sub} numberOfLines={1}>
              {cue.sub}
            </Text>
          )}
        </View>
      </Animated.View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: {
    position: 'absolute',
    top: spacing.md,
    left: 0,
    right: 0,
    alignItems: 'center',
  },
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    maxWidth: '78%',
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    paddingVertical: spacing.md,
    borderRadius: radius.full,
    borderWidth: 2,
    backgroundColor: 'rgba(0,0,0,0.72)',
    // The camera feed behind this can be anything from a dark room to a bright
    // window, so the pill carries its own contrast.
    shadowColor: '#000',
    shadowOpacity: 0.5,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: 4 },
    elevation: 8,
  },
  iconCircle: {
    width: 44,
    height: 44,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  textCol: { flexShrink: 1 },
  headline: {
    color: '#fff',
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '800',
    letterSpacing: 0.4,
    textShadowColor: 'rgba(0,0,0,0.6)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  sub: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 15,
    fontWeight: '600',
    marginTop: 2,
  },
});
