import { create } from 'zustand';

/** A target's position in window coordinates, as reported by measureInWindow. */
export interface SpotlightRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Registry of measured coachmark targets, keyed by the string ids in
 * src/constants/activationScript.ts.
 *
 * Deliberately not persisted: a rect is only meaningful for the mounted screen
 * that produced it, and a stale one from a previous launch would put the
 * spotlight hole over empty space.
 */
interface SpotlightState {
  rects: Record<string, SpotlightRect>;
  /** Bumped to ask every mounted target to measure itself again. */
  tick: number;
  setRect: (id: string, rect: SpotlightRect | null) => void;
  /**
   * Call after anything that moves a target without re-laying it out — chiefly
   * scrolling, which does not fire onLayout, so a rect measured before the
   * scroll would put the cutout over the wrong part of the screen.
   */
  remeasure: () => void;
}

export const useSpotlightStore = create<SpotlightState>((set) => ({
  rects: {},
  tick: 0,

  remeasure: () => set((state) => ({ tick: state.tick + 1 })),

  setRect: (id, rect) =>
    set((state) => {
      if (!rect) {
        if (!(id in state.rects)) return state;
        const { [id]: _dropped, ...rest } = state.rects;
        return { rects: rest };
      }
      const prev = state.rects[id];
      // onLayout fires on every re-render of the target; bail when nothing moved
      // so a measurement can't loop the overlay's animation forever.
      if (
        prev &&
        prev.x === rect.x &&
        prev.y === rect.y &&
        prev.width === rect.width &&
        prev.height === rect.height
      ) {
        return state;
      }
      return { rects: { ...state.rects, [id]: rect } };
    }),
}));
