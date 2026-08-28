/**
 * Copy for the two-position bow calibration that runs before a live take
 * (see src/components/practice/BowCalibrationFlow.tsx for the state machine,
 * src/lib/calibrationCompute.ts for what the captures are used for).
 *
 * Kept apart from the flow so the wording can be tuned without touching the
 * timing. Two rules, both about how little the player can absorb here:
 *
 *   • The diagrams do the explaining. Text names the position; it does not
 *     describe the picture sitting next to it.
 *   • Nothing shown during a hold is longer than a few words — by then the
 *     player is a couple of metres away, holding a violin, and reading with
 *     half an eye. One instruction per screen: move, or freeze.
 */

export interface CalibrationPosition {
  /** Shown as "Position n of 2". */
  index: 1 | 2;
  /** Which of the two ViolinDiagram layouts illustrates this position. */
  mode: 'bridge' | 'fingerboard';
  /** ≤4 words. Diagram caption, and the reminder during the hold. */
  name: string;
  /** Names the two landmarks for anyone who doesn't know the words. Intro only. */
  hint: string;
  /**
   * Carried from the intro chip through the prep kicker to the hold ring, so a
   * single colour identifies which of the two positions is on screen.
   */
  accent: string;
}

/**
 * Order matters — this is the order computeCalibration() expects the clips in
 * (bridge/tip first, then fingerboard/frog).
 *
 * The two positions are the opposite extremes of a real bow stroke: a down-bow
 * ends at the tip near the bridge, an up-bow ends at the frog near the
 * fingerboard. Each one pins both measured axes at once.
 */
export const CALIBRATION_POSITIONS: readonly [CalibrationPosition, CalibrationPosition] = [
  {
    index: 1,
    mode: 'bridge',
    name: 'Tip at the bridge',
    hint: 'Far end of the bow.',
    accent: '#38bdf8',
  },
  {
    index: 2,
    mode: 'fingerboard',
    name: 'Frog at the fingerboard',
    hint: 'Hand end of the bow.',
    accent: '#c084fc',
  },
];

export const CALIBRATION_COPY = {
  intro: {
    kicker: 'Before you play',
    title: 'Two bow positions',
    body: 'The camera takes a look at your bow in each one. Hold still for 5 seconds each.',
    cta: 'Start',
  },

  /** Stage 1 of each position: the player is moving into place. */
  prep: {
    headline: 'Get into position',
    /** Sits under the countdown number so the digit is never unlabelled. */
    numberLabel: 'starting in',
  },

  /** Stage 2 of each position: the capture is running and the player must freeze. */
  hold: {
    headline: 'HOLD STILL',
    numberLabel: 'seconds left',
  },

  /** The beat between position 1 and position 2, so the two countdowns don't run together. */
  handoff: {
    kicker: 'Got it',
    title: 'Now position 2',
  },

  review: {
    kicker: 'Done',
    title: 'Calibration saved',
    body: 'Leave the phone where it is.',
  },

  /**
   * The one case that still stops the flow: the camera found no bow at all,
   * in either clip. Every other computeCalibration() rejection now continues
   * uncalibrated without showing anything — see BowCalibrationFlow.
   *
   * Kept deliberately blame-free. The player did the holds; it was the camera
   * that came back empty, and the fix is where the phone is pointing.
   */
  failure: {
    kicker: 'Nothing in frame',
    title: "Couldn't see your bow",
    retry: 'Run it again',
    /** Bow metrics fall back to uncalibrated behaviour — the take is still usable. */
    skip: 'Continue anyway',
  },
} as const;
