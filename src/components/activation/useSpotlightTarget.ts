import { useCallback, useEffect, useRef } from 'react';
import type { View } from 'react-native';
import { useSpotlightStore } from './spotlightStore';

/**
 * Registers a view as a coachmark target under a stable string id, so
 * SpotlightOverlay can punch its hole over the real element rather than over a
 * hardcoded rectangle that drifts the moment the layout changes.
 *
 * Usage — spread the whole thing onto the wrapping view:
 *
 *   <View {...useSpotlightTarget('carousel.score')}>…</View>
 *
 * Pass `null` to opt out. That matters wherever the same component is rendered
 * many times — the results carousel mounts all ten of its pages at once, so
 * only the page a step actually points at may claim the id, or an off-screen
 * copy would overwrite the rect with coordinates outside the viewport.
 *
 * `collapsable: false` is not optional. Android flattens view-only nodes out of
 * the native hierarchy, and a flattened view has nothing to measure — the rect
 * comes back as zeros and the spotlight lands in the top-left corner.
 */
export function useSpotlightTarget(id: string | null) {
  const ref = useRef<View>(null);
  // Re-measure whenever anything asks (see spotlightStore.remeasure) — scrolling
  // moves a target without firing onLayout.
  const tick = useSpotlightStore((s) => s.tick);

  const measure = useCallback(() => {
    if (!id) return;
    // measureInWindow can fire before the native view exists (first layout pass
    // on a screen that's still animating in). A zero-size result is never a real
    // target, so drop it and wait for the next onLayout.
    ref.current?.measureInWindow((x, y, width, height) => {
      if (width <= 0 || height <= 0) return;
      useSpotlightStore.getState().setRect(id, { x, y, width, height });
    });
  }, [id]);

  useEffect(() => {
    if (!id) return;
    // A screen that mounts already laid out (a carousel page scrolled into view)
    // may never fire onLayout, so take one measurement after the first frame.
    const t = setTimeout(measure, 80);
    return () => {
      clearTimeout(t);
      useSpotlightStore.getState().setRect(id, null);
    };
  }, [id, measure]);

  // Kept separate from the mount effect above on purpose: folding `tick` into
  // that one would run its cleanup on every remeasure, blanking the rect for a
  // frame and making the overlay flicker back to its no-target fallback.
  useEffect(() => {
    if (!id || tick === 0) return;
    measure();
  }, [id, measure, tick]);

  return { ref, onLayout: measure, collapsable: false } as const;
}
