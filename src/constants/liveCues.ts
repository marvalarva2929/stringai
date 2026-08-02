/**
 * Copy for the in-the-moment coaching cues shown over the recording camera
 * (see src/lib/liveCoach.ts for when each one fires).
 *
 * Kept apart from the detection logic so the wording can be tuned without
 * touching thresholds. Two writing rules, both driven by the reading distance —
 * the player is two metres away, holding a violin, and cannot touch the phone:
 *
 *   • headline ≤ 4 words. It is set at 34pt and must be readable at a glance,
 *     mid-stroke, without stopping. This is the only part most players will read.
 *   • sub ≤ 6 words. The actual instruction, for the player who has a moment to
 *     look. Never essential — the headline has to stand alone.
 *
 * Praise cues carry no sub: "NICE VIBRATO" needs no elaboration, and adding one
 * turns a moment of encouragement into another thing to read.
 */

export type CueKind = 'setup' | 'fix' | 'praise';

export interface CueCopy {
  kind: CueKind;
  headline: string;
  sub?: string;
  /** Ionicons name. */
  icon: string;
}

export type CueId =
  | 'no_pose'
  | 'no_bow'
  | 'wrist_collapsed'
  | 'elbow_low'
  | 'shoulders_uneven'
  | 'short_bow'
  | 'camped_lower'
  | 'camped_upper'
  | 'bow_wobble'
  | 'tone_scratchy'
  | 'tone_thin'
  | 'pitch_sharp'
  | 'pitch_flat'
  | 'good_vibrato'
  | 'full_bow'
  | 'steady_bow'
  | 'in_tune'
  | 'even_tone';

export const LIVE_CUES: Record<CueId, CueCopy> = {
  // ── Setup: the take is not measurable until these are fixed ──────────────
  no_pose: {
    kind: 'setup',
    headline: 'Step into frame',
    sub: 'get back in the camera',
    icon: 'body-outline',
  },
  no_bow: {
    kind: 'setup',
    headline: 'Show the bow',
    sub: 'keep it inside the frame',
    icon: 'scan-outline',
  },

  // ── Fixes ────────────────────────────────────────────────────────────────
  wrist_collapsed: {
    kind: 'fix',
    headline: 'Straighten your wrist',
    sub: 'keep the left wrist flat',
    icon: 'hand-left-outline',
  },
  elbow_low: {
    kind: 'fix',
    headline: 'Lift your bow arm',
    sub: 'elbow up to string level',
    icon: 'arrow-up-outline',
  },
  shoulders_uneven: {
    kind: 'fix',
    headline: 'Level your shoulders',
    sub: 'let the right one drop',
    icon: 'reorder-two-outline',
  },
  short_bow: {
    kind: 'fix',
    headline: 'Use more bow',
    sub: 'travel frog to tip',
    icon: 'resize-outline',
  },
  camped_lower: {
    kind: 'fix',
    headline: 'Reach the tip',
    sub: "you're living at the frog",
    icon: 'arrow-forward-outline',
  },
  camped_upper: {
    kind: 'fix',
    headline: 'Reach the frog',
    sub: "you're living at the tip",
    icon: 'arrow-back-outline',
  },
  bow_wobble: {
    kind: 'fix',
    headline: 'Steady the bow',
    sub: 'hold one stick angle',
    icon: 'remove-outline',
  },
  // Sound-quality fixes, framed the way a teacher would: what the sound is
  // doing, then the bow change that fixes it (the Schelleng speed/pressure
  // trade-off — scratch is over-pressure, thin is under-pressure).
  tone_scratchy: {
    kind: 'fix',
    headline: 'Sounds scratchy',
    sub: 'faster bow, less pressure',
    icon: 'flash-off-outline',
  },
  tone_thin: {
    kind: 'fix',
    headline: 'Sounds thin',
    sub: 'slower bow, more pressure',
    icon: 'flash-outline',
  },
  pitch_sharp: {
    kind: 'fix',
    headline: 'A little sharp',
    sub: 'ease the finger back',
    icon: 'trending-down-outline',
  },
  pitch_flat: {
    kind: 'fix',
    headline: 'A little flat',
    sub: 'reach the finger forward',
    icon: 'trending-up-outline',
  },

  // ── Praise: earned, never automatic (see the praise gating in liveCoach) ──
  good_vibrato: { kind: 'praise', headline: 'Nice vibrato', icon: 'pulse-outline' },
  full_bow:     { kind: 'praise', headline: 'Full bow — nice', icon: 'resize-outline' },
  steady_bow:   { kind: 'praise', headline: 'Great bow control', icon: 'checkmark-circle-outline' },
  in_tune:      { kind: 'praise', headline: 'Right in tune', icon: 'musical-note-outline' },
  even_tone:    { kind: 'praise', headline: 'Lovely even tone', icon: 'sparkles-outline' },
};
