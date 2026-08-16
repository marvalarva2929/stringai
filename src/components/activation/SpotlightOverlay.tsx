import React, { useState } from 'react';
import { View, Text, Pressable, StyleSheet, Modal, Dimensions, Platform } from 'react-native';
import Animated, { LinearTransition } from 'react-native-reanimated';
import Svg, { Path } from 'react-native-svg';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSpotlightStore } from './spotlightStore';
import { haptic } from '../../lib/haptics';
import { colors, spacing, radius } from '../../constants/theme';
import type { SpotlightStep } from '../../constants/activationScript';

const { width: SCREEN_W, height: SCREEN_H } = Dimensions.get('window');

/** Breathing room between the highlighted element and the edge of the cutout. */
const HOLE_PAD = 10;
const DEFAULT_RADIUS = 18;
/** Gap between the cutout and the tooltip card. */
const GAP = 14;
const ARROW = 9;
const SCRIM = 'rgba(9,14,26,0.84)';

export interface SpotlightOverlayProps {
  steps: SpotlightStep[];
  /** Index into `steps`. Out of range renders nothing (unless `blocking`). */
  index: number;
  onNext: () => void;
  onSkip: () => void;
  /**
   * True while activation owns this screen. Keeps a bare scrim up during the
   * moments between steps — a screen mounting, a target still measuring, a
   * navigation animating — so there is never a frame in which the user can tap
   * something else and fall out of the flow.
   */
  blocking?: boolean;
}

/**
 * A dimmed screen with a cutout over a real, measured element, plus a tooltip.
 *
 * Three things here are load-bearing and were learned the hard way:
 *
 * 1. It IS a Modal. An earlier version rendered inline so a step could let the
 *    user swipe the screen underneath — but an inline overlay inherits its
 *    parent's origin (a SafeAreaView's top inset pushed the tooltip off-screen)
 *    and cannot cover siblings like the tab bar, so the user could tap straight
 *    past the flow. A Modal is its own full-window surface: window coordinates
 *    from measureInWindow line up exactly, and nothing outside it is reachable.
 *
 * 2. The scrim is ONE svg path with an even-odd fill, not a stack of rectangles
 *    around the hole. Four abutting views leave hairline seams and can only ever
 *    produce a square hole; a single path gives a clean rounded cutout that hugs
 *    the element's own shape.
 *
 * 3. If the target hasn't been measured, it falls back to a centred tooltip with
 *    no cutout instead of rendering nothing. Since the modal blocks everything
 *    beneath it, a step that silently drew nothing would trap the user behind an
 *    invisible wall.
 */
export function SpotlightOverlay({ steps, index, onNext, onSkip, blocking }: SpotlightOverlayProps) {
  const step = index >= 0 && index < steps.length ? steps[index] : null;
  const rect = useSpotlightStore((s) => (step ? s.rects[step.targetId] : undefined));
  const insets = useSafeAreaInsets();
  const [tooltipH, setTooltipH] = useState(0);

  if (!step) {
    if (!blocking) return null;
    // Between steps: hold the screen without a card, rather than briefly
    // handing back control and letting the user tap out of the flow.
    return (
      <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onSkip}>
        <View style={[StyleSheet.absoluteFill, { backgroundColor: SCRIM }]} />
      </Modal>
    );
  }

  const advance = () => {
    haptic.light();
    onNext();
  };

  const hole = rect
    ? {
        x: Math.max(0, rect.x - HOLE_PAD),
        y: Math.max(0, rect.y - HOLE_PAD),
        w: rect.width + HOLE_PAD * 2,
        h: rect.height + HOLE_PAD * 2,
        r: step.radius ?? DEFAULT_RADIUS,
      }
    : null;

  // Vertical placement. Computed as a `top` in every branch — deriving one edge
  // from `bottom` and the other from `top` is what put the card off-screen before.
  const minTop = insets.top + spacing.sm;
  const maxTop = SCREEN_H - insets.bottom - spacing.sm - tooltipH;

  let tooltipTop = Math.max(minTop, (SCREEN_H - tooltipH) / 2);
  let arrow: 'up' | 'down' | null = null;

  if (hole && tooltipH > 0) {
    const below = hole.y + hole.h + GAP;
    const above = hole.y - GAP - tooltipH;
    const fitsBelow = below <= maxTop;
    const fitsAbove = above >= minTop;
    // Honour the requested side when it fits; otherwise take whichever does.
    const goBelow =
      step.placement === 'below' ? fitsBelow || !fitsAbove
      : step.placement === 'above' ? !fitsAbove && fitsBelow
      : fitsBelow;

    if (goBelow && fitsBelow) {
      tooltipTop = below;
      arrow = 'up'; // sits under the element, so its arrow points up at it
    } else if (fitsAbove) {
      tooltipTop = above;
      arrow = 'down';
    } else {
      // Taller than either gap — take the roomier side and drop the arrow.
      const roomAbove = hole.y - minTop;
      const roomBelow = maxTop - (hole.y + hole.h);
      tooltipTop = roomBelow >= roomAbove ? below : above;
    }
    tooltipTop = Math.min(Math.max(tooltipTop, minTop), Math.max(minTop, maxTop));
  }

  // The arrow tracks the element's centre, clamped so it stays on the card.
  const arrowLeft = hole
    ? Math.min(
        Math.max(hole.x + hole.w / 2 - spacing.md, spacing.md + ARROW * 2),
        SCREEN_W - spacing.md * 2 - ARROW * 2,
      )
    : SCREEN_W / 2 - spacing.md;

  const isLast = index === steps.length - 1;

  return (
    <Modal visible transparent statusBarTranslucent animationType="fade" onRequestClose={onSkip}>
      {/* Swallows every touch that isn't the tooltip's own buttons — the flow
          can only be left through Skip. */}
      <Pressable style={StyleSheet.absoluteFill} onPress={hole ? advance : undefined}>
        <Svg width={SCREEN_W} height={SCREEN_H} style={StyleSheet.absoluteFill}>
          <Path d={scrimPath(hole)} fill={SCRIM} fillRule="evenodd" />
        </Svg>

        {hole && (
          <View
            pointerEvents="none"
            style={[
              s.halo,
              { top: hole.y, left: hole.x, width: hole.w, height: hole.h, borderRadius: hole.r },
            ]}
          />
        )}

        {/* Deliberately not keyed on step.id: keeping one card mounted across
            steps is what lets it glide to the next target instead of blinking
            out and back. Opacity is gated on the first measurement so it never
            flashes at the fallback position before it knows its own height. */}
        <Animated.View
          layout={LinearTransition.duration(260)}
          onLayout={(e) => setTooltipH(e.nativeEvent.layout.height)}
          style={[s.card, { top: tooltipTop, opacity: tooltipH > 0 ? 1 : 0 }]}
        >
          {arrow === 'up' && <View style={[s.arrowUp, { left: arrowLeft }]} />}

          <Text style={s.title}>{step.title}</Text>
          <Text style={s.body}>{step.body}</Text>

          <View style={s.footer}>
            <View style={s.progress}>
              {steps.map((st, i) => (
                <View key={st.id} style={[s.tick, i === index && s.tickActive]} />
              ))}
            </View>

            <View style={s.buttons}>
              <Pressable onPress={onSkip} hitSlop={10} style={s.skipBtn}>
                <Text style={s.skip}>Skip</Text>
              </Pressable>
              <Pressable onPress={advance} style={({ pressed }) => [s.cta, pressed && s.ctaPressed]}>
                <Text style={s.ctaText}>{step.cta ?? (isLast ? 'Got it' : 'Next')}</Text>
              </Pressable>
            </View>
          </View>

          {arrow === 'down' && <View style={[s.arrowDown, { left: arrowLeft }]} />}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

type Hole = { x: number; y: number; w: number; h: number; r: number } | null;

/**
 * Full-screen rectangle with a rounded rectangle punched out of it.
 *
 * Both subpaths wind the same way; `fillRule="evenodd"` is what turns the inner
 * one into a hole rather than an overlapping fill.
 */
function scrimPath(hole: Hole): string {
  const outer = `M0,0 H${SCREEN_W} V${SCREEN_H} H0 Z`;
  if (!hole) return outer;

  const { x, y, w, h } = hole;
  // A radius larger than half the shorter side would produce a self-crossing arc.
  const r = Math.min(hole.r, w / 2, h / 2);

  const inner =
    `M${x + r},${y} ` +
    `H${x + w - r} A${r},${r} 0 0 1 ${x + w},${y + r} ` +
    `V${y + h - r} A${r},${r} 0 0 1 ${x + w - r},${y + h} ` +
    `H${x + r} A${r},${r} 0 0 1 ${x},${y + h - r} ` +
    `V${y + r} A${r},${r} 0 0 1 ${x + r},${y} Z`;

  return `${outer} ${inner}`;
}

const s = StyleSheet.create({
  halo: {
    position: 'absolute',
    borderWidth: 2,
    borderColor: 'rgba(255,255,255,0.9)',
  },

  card: {
    position: 'absolute',
    left: spacing.md,
    right: spacing.md,
    backgroundColor: '#fff',
    borderRadius: 20,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.lg,
    paddingBottom: spacing.md,
    gap: spacing.xs,
    ...Platform.select({
      ios: {
        shadowColor: '#000',
        shadowOffset: { width: 0, height: 8 },
        shadowOpacity: 0.28,
        shadowRadius: 24,
      },
      android: { elevation: 12 },
    }),
  },
  arrowUp: {
    position: 'absolute',
    top: -ARROW,
    width: 0,
    height: 0,
    borderLeftWidth: ARROW,
    borderRightWidth: ARROW,
    borderBottomWidth: ARROW,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#fff',
  },
  arrowDown: {
    position: 'absolute',
    bottom: -ARROW,
    width: 0,
    height: 0,
    borderLeftWidth: ARROW,
    borderRightWidth: ARROW,
    borderTopWidth: ARROW,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderTopColor: '#fff',
  },

  title: { fontSize: 19, fontWeight: '800', color: colors.text.primary, letterSpacing: -0.2 },
  body: { fontSize: 15, lineHeight: 21, color: colors.text.secondary },

  footer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.md,
  },
  progress: { flexDirection: 'row', gap: 5, alignItems: 'center' },
  tick: { width: 6, height: 6, borderRadius: radius.full, backgroundColor: '#d8dee9' },
  tickActive: { width: 18, backgroundColor: colors.brand[600] },

  buttons: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  skipBtn: { paddingHorizontal: spacing.sm, paddingVertical: 10 },
  skip: { fontSize: 14, color: colors.text.muted, fontWeight: '700' },
  cta: {
    backgroundColor: colors.brand[600],
    paddingHorizontal: spacing.lg,
    paddingVertical: 11,
    borderRadius: radius.full,
  },
  ctaPressed: { opacity: 0.85 },
  ctaText: { color: '#fff', fontSize: 14, fontWeight: '800', letterSpacing: 0.3 },
});
