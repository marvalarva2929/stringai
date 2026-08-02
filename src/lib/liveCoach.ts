/**
 * Live coaching for a recording in progress: decides what single tip to put on
 * screen while the player is playing (see LiveCoachBanner for how it's shown).
 *
 * Two design rules shape everything here.
 *
 * 1. It measures the SAME arrays, with the SAME functions and thresholds, as the
 *    session report. The recording screen already accumulates FrameKeypoints and
 *    RawBowFrames for the offline pipeline; this module reads a trailing window
 *    off those, runs deriveBowTimeSeries/analyzeBowUsage/leftWristAngleFromFrame
 *    over it, and compares against poseScoring's THRESHOLDS. A live tip that
 *    contradicted the verdict five minutes later would be worse than no tip.
 *
 * 2. It is deliberately quiet. A coach that talks constantly is noise you learn
 *    to ignore, and the player cannot dismiss anything — they're holding a
 *    violin two metres away. So: one cue at a time, a grace period at the start,
 *    per-cue cooldowns, a global rate limit, round-robin between competing
 *    fixes, praise only when nothing needs fixing, and nothing at all while the
 *    room is silent.
 *
 * Pure: no React, no Expo, no clock. Time comes in on the snapshot, so the whole
 * scheduler is deterministic and testable (test/liveCoach.test.ts).
 */

import { LIVE_CUES, type CueId, type CueKind, type CueCopy } from '../constants/liveCues';
import {
  THRESHOLDS,
  CONFIDENCE_THRESHOLD,
  POSE,
  leftWristAngleFromFrame,
  shoulderDiffFromFrame,
  type FrameKeypoints,
  type Landmark,
} from './poseScoring';
import { deriveBowTimeSeries, analyzeBowUsage } from './bowAnalysis';
import { classifyVibratoSegment } from '../services/pitchContour';
import { centsFromNearestNote } from '../services/dsp';
import type { RawBowFrame } from '../types/signals';

export type { CueId, CueKind };

export interface LiveCue extends CueCopy {
  id: CueId;
}

export interface LiveSnapshot {
  /** Seconds since recording started. Drives every timing decision below. */
  t: number;
  /** Pose frames from the trailing window (COACH_WINDOW_S). */
  poseFrames: FrameKeypoints[];
  /** Bow frames from the trailing window. May be empty — pose/pitch cues still fire. */
  bowFrames: RawBowFrame[];
  /** Pitch ring, oldest → newest, PITCH_HZ samples/sec. null = unvoiced. */
  pitchHz: (number | null)[];
  /** Loudness ring aligned with pitchHz. Empty when the native build predates
   *  the rms payload — callers get frequency-only voicing instead. */
  rms: number[];
  /** Tonality ring aligned with pitchHz: ~1 = clean periodic tone, low = noisy/
   *  scratchy. Empty on native builds without the clarity payload — the tone
   *  cues simply don't fire there. */
  clarity: number[];
}

export interface LiveCoach {
  /** The cue to display right now, or null for a clear screen. */
  tick(snapshot: LiveSnapshot): LiveCue | null;
  reset(): void;
}

// ─── Windows ─────────────────────────────────────────────────────────────────
// The longest window any detector asks for. Callers slice their accumulating
// refs to this before handing them over, so the coach never walks a whole take.
export const COACH_WINDOW_S = 8;
/** Sample rate of the pitch/rms rings (PoseCameraView emits every 50 ms). */
export const PITCH_HZ = 20;

const WRIST_WINDOW_S = 2;
const ELBOW_WINDOW_S = 2;
const SHOULDER_WINDOW_S = 3;
const SETUP_WINDOW_S = 1.5;
const NO_BOW_WINDOW_S = 4;
const SHORT_BOW_WINDOW_S = 6;
const CAMPED_WINDOW_S = 8;
const WOBBLE_WINDOW_S = 3;
const STEADY_BOW_WINDOW_S = 5;

// ─── Scheduling ──────────────────────────────────────────────────────────────
/** Nothing but setup cues before this — the first seconds are the player settling. */
const GRACE_S = 4;
/** How long a cue stays up. Long enough to read mid-stroke, short enough to not linger. */
const MIN_DISPLAY_S = 2.8;
/** Clear air after a cue, so two cues never read as one run-on message. */
const MIN_GAP_S = 1.5;
/** Hard ceiling on cue frequency, whatever is going wrong. */
const GLOBAL_MIN_INTERVAL_S = 6;
const FIX_COOLDOWN_S = 20;
const PRAISE_COOLDOWN_S = 25;

// ─── Detection thresholds ────────────────────────────────────────────────────
// Positional pose thresholds carried over from the recording screen's original
// warning pass (analyze.tsx), in normalized frame coords with y down.
const ARM_TOO_LOW_THRESHOLD = 0.22;
/**
 * Live wrist gate, intentionally looser than the report's minStraightAngle (160°).
 * The bow arm passes through awkward angles every stroke; nagging at 160° live
 * would fire on normal playing, so only a clearly collapsed wrist gets a cue.
 */
const LIVE_WRIST_MIN_ANGLE = 155;
/** Fraction of measurable frames in a window that must be bad before a fix fires. */
const FIX_BAD_SHARE = 0.6;
const WOBBLE_BAD_SHARE = 0.4;
/** Fraction that must be GOOD before praise fires — praise has to be earned. */
const PRAISE_GOOD_SHARE = 0.9;
/** Direction changes required before bow-distribution judgements mean anything:
 *  you cannot assess bow usage from a single stroke. */
const MIN_STROKES_FIX = 2;
const MIN_STROKES_PRAISE = 3;

// Audio gates.
const PLAYING_RMS = 0.02;
const SILENCE_WINDOW_S = 2;
// Vibrato praise is deliberately hard to earn — a false "Nice vibrato" on a
// plain note teaches nothing and erodes trust in the coach. It requires a single
// SUSTAINED note (not a scan of the whole window) that is genuinely oscillating:
// real depth, an in-range rate, and clear periodicity.
const VIBRATO_MIN_NOTE_S = 1.2;   // the note has to be held this long
const VIBRATO_MIN_DEPTH_CENTS = 12;
const VIBRATO_MIN_RATE_HZ = 4.0;
const VIBRATO_MAX_RATE_HZ = 7.5;
const VIBRATO_MIN_PERIODICITY = 0.3; // above classifyVibratoSegment's own 0.22 gate

const PITCH_OFF_CENTS = 25;
const PITCH_OFF_MIN_S = 1.5;
const PITCH_OFF_MAX_SPREAD = 30;
const IN_TUNE_CENTS = 10;
const IN_TUNE_MIN_S = 2.5;
const EVEN_TONE_MIN_S = 2;
const EVEN_TONE_MAX_CV = 0.25;

// Sound quality. clarity is the native normalized-autocorrelation tonality
// measure (~1 clean, low = noisy/scratchy). Both cues need the roughness
// SUSTAINED across the window so bow changes and note onsets — momentary dips —
// don't trip them. scratch vs thin is split by loudness: rough + loud reads as
// over-pressure (scratch), rough + quiet as under-pressure (thin). Thresholds
// are first-pass and want on-device tuning.
const TONE_WINDOW_S = 2.5;
const TONE_MIN_VOICED_FRAMES = Math.round(TONE_WINDOW_S * 20 * 0.7);
const TONE_ROUGH_CLARITY = 0.45;   // clarity below this = not a clean tone
const TONE_ROUGH_SHARE = 0.6;      // fraction of the window that must be rough
const TONE_SCRATCH_RMS = 0.06;     // rough & at/above this loudness → scratch, else thin

// Running bow-angle baseline, capped so a long take can't grow it without bound.
const ANGLE_HISTORY_CAP = 2000;

// The arm landmarks. A front-facing camera routinely drops one arm out of frame
// as the player moves, so "get in frame" only fires when NEITHER arm is visible
// — a frame showing even one of these counts as the player being present.
const ARM_LANDMARKS = [
  POSE.LEFT_SHOULDER, POSE.LEFT_ELBOW, POSE.LEFT_WRIST,
  POSE.RIGHT_SHOULDER, POSE.RIGHT_ELBOW, POSE.RIGHT_WRIST,
];
// Fire no_pose only when the recent window is dominated by frames with no arm at
// all (i.e. the player is genuinely out of shot), not merely missing one arm.
const NO_POSE_PRESENT_SHARE = 0.25;

// ─── Small helpers ───────────────────────────────────────────────────────────

function visible(lm: Landmark | undefined): boolean {
  if (!lm) return false;
  return lm.visibility === undefined || lm.visibility >= CONFIDENCE_THRESHOLD;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Items with a timestamp inside the last `seconds` of the snapshot. */
function since<T extends { timestamp: number }>(items: T[], t: number, seconds: number): T[] {
  const cutoff = t - seconds;
  return items.filter((item) => item.timestamp >= cutoff);
}

/** The tail of a ring covering the last `seconds`. */
function ringTail<T>(ring: T[], seconds: number): T[] {
  return ring.slice(Math.max(0, ring.length - Math.round(seconds * PITCH_HZ)));
}

/**
 * The current sustained note: the last run of pitches with no >100¢ jump (the
 * same note-boundary rule scoreVibrato uses offline). Taking only this segment —
 * rather than scanning the whole window — is what stops a brief waver on any
 * earlier note, or a scale run, from being read as vibrato.
 */
function currentNoteSegment(voicedRun: number[]): number[] {
  if (voicedRun.length === 0) return [];
  let seg: number[] = [voicedRun[0]];
  for (let i = 1; i < voicedRun.length; i++) {
    const jump = Math.abs(1200 * Math.log2(voicedRun[i] / voicedRun[i - 1]));
    if (jump > 100) seg = [voicedRun[i]];
    else seg.push(voicedRun[i]);
  }
  return seg;
}

/**
 * Real vibrato on the note being held right now: a sustained note that is
 * genuinely oscillating — real depth, an in-range rate, clearly periodic. All
 * three gates must pass, which is what keeps "Nice vibrato" from firing on a
 * plain or slightly-wavering note.
 */
export function isSustainedVibrato(note: number[]): boolean {
  if (note.length < VIBRATO_MIN_NOTE_S * PITCH_HZ) return false;
  const medianFreq = median(note);
  const devs = note.map((f) => 1200 * Math.log2(f / medianFreq));
  const v = classifyVibratoSegment(devs, PITCH_HZ);
  return (
    v.isVibrato &&
    v.depth >= VIBRATO_MIN_DEPTH_CENTS &&
    v.rate >= VIBRATO_MIN_RATE_HZ &&
    v.rate <= VIBRATO_MAX_RATE_HZ &&
    v.periodicityScore >= VIBRATO_MIN_PERIODICITY
  );
}

/** Sign flips in the bow direction series — one per stroke change. */
function countStrokes(directions: Array<number | null>): number {
  let strokes = 0;
  let last = 0;
  for (const d of directions) {
    if (d == null || d === 0) continue;
    if (last !== 0 && d !== last) strokes++;
    last = d;
  }
  return strokes;
}

/** The most recent unbroken run of voiced samples, as {hz, index} pairs. */
function latestVoicedRun(pitchHz: (number | null)[], voiced: boolean[]): number[] {
  const run: number[] = [];
  for (let i = pitchHz.length - 1; i >= 0; i--) {
    const hz = pitchHz[i];
    if (!voiced[i] || hz == null) break;
    run.unshift(hz);
  }
  return run;
}

// ─── The coach ───────────────────────────────────────────────────────────────

export function createLiveCoach(): LiveCoach {
  let angleHistory: number[] = [];
  let lastAngleT = -Infinity;
  let lastShownAt = new Map<CueId, number>();
  let lastAnyShownAt = -Infinity;
  let lastDismissedAt = -Infinity;
  let current: { cue: LiveCue; shownAt: number } | null = null;

  const reset = () => {
    angleHistory = [];
    lastAngleT = -Infinity;
    lastShownAt = new Map();
    lastAnyShownAt = -Infinity;
    lastDismissedAt = -Infinity;
    current = null;
  };

  /**
   * Every cue whose condition holds this tick, in no particular order.
   * Selection (priority, cooldowns, rate limiting) happens in tick().
   */
  const detect = (snap: LiveSnapshot): CueId[] => {
    const { t, poseFrames, bowFrames } = snap;
    const found: CueId[] = [];

    // ── Setup ───────────────────────────────────────────────────────────────
    // Held back for the first couple of seconds so a cold camera doesn't greet
    // the player with a red banner before it has seen anything.
    if (t >= 2.5) {
      const setupWindow = since(poseFrames, t, SETUP_WINDOW_S);
      // "Player present" = at least one arm landmark visible. Losing a single arm
      // to a front-facing camera is normal and must not trip the cue.
      const framesWithPlayer = setupWindow.filter((f) => {
        const pose = f.poseLandmarks;
        if (!pose) return false;
        return ARM_LANDMARKS.some((i) => visible(pose[i]));
      }).length;
      // No frames at all, or almost none showing any arm: nobody is in view.
      if (setupWindow.length === 0 || framesWithPlayer / setupWindow.length < NO_POSE_PRESENT_SHARE) {
        found.push('no_pose');
      } else if (since(bowFrames, t, NO_BOW_WINDOW_S).length === 0 && t >= NO_BOW_WINDOW_S) {
        found.push('no_bow');
      }
    }

    // ── Pose fixes ──────────────────────────────────────────────────────────
    const wristAngles = since(poseFrames, t, WRIST_WINDOW_S)
      .map((f) => leftWristAngleFromFrame(f)?.angle)
      .filter((a): a is number => a != null);
    if (wristAngles.length >= 8) {
      const bad = wristAngles.filter((a) => a < LIVE_WRIST_MIN_ANGLE).length;
      if (bad / wristAngles.length >= FIX_BAD_SHARE) found.push('wrist_collapsed');
    }

    const elbowDrops = since(poseFrames, t, ELBOW_WINDOW_S)
      .map((f) => {
        const pose = f.poseLandmarks;
        if (!pose) return null;
        const shoulder = pose[POSE.RIGHT_SHOULDER];
        const elbow = pose[POSE.RIGHT_ELBOW];
        if (!visible(shoulder) || !visible(elbow)) return null;
        return elbow.y - shoulder.y;
      })
      .filter((d): d is number => d != null);
    if (elbowDrops.length >= 8) {
      const bad = elbowDrops.filter((d) => d > ARM_TOO_LOW_THRESHOLD).length;
      if (bad / elbowDrops.length >= FIX_BAD_SHARE) found.push('elbow_low');
    }

    const shoulderDiffs = since(poseFrames, t, SHOULDER_WINDOW_S)
      .map((f) => shoulderDiffFromFrame(f))
      .filter((d): d is number => d != null);
    if (shoulderDiffs.length >= 12) {
      const bad = shoulderDiffs.filter((d) => d > THRESHOLDS.posture.shoulderDiff).length;
      if (bad / shoulderDiffs.length >= FIX_BAD_SHARE) found.push('shoulders_uneven');
    }

    // ── Bow ─────────────────────────────────────────────────────────────────
    // One derivation over the widest bow window; the narrower detectors slice it.
    const bowWindow = since(bowFrames, t, CAMPED_WINDOW_S);
    if (bowWindow.length >= 8) {
      const series = deriveBowTimeSeries(bowWindow);
      const contactPts = series.bowContactPoint.points.filter((p) => p.v !== null) as Array<{ t: number; v: number }>;
      const anglePts = series.bowAngle.points.filter((p) => p.v !== null) as Array<{ t: number; v: number }>;

      // Only frames not seen before: the windows overlap heavily at 4 Hz, and
      // re-adding them would collapse the "whole take" baseline into a running
      // median of the last couple of seconds.
      for (const pt of anglePts) {
        if (pt.t <= lastAngleT) continue;
        angleHistory.push(pt.v);
        lastAngleT = pt.t;
      }
      if (angleHistory.length > ANGLE_HISTORY_CAP) {
        angleHistory = angleHistory.slice(angleHistory.length - ANGLE_HISTORY_CAP);
      }

      const strokesIn = (seconds: number) =>
        countStrokes(series.bowDirection.window(t - seconds, t).map((p) => p.v));
      const usageIn = (seconds: number) => {
        const values = contactPts.filter((p) => p.t >= t - seconds).map((p) => p.v);
        return values.length >= THRESHOLDS.bow.minFrames ? analyzeBowUsage(values) : null;
      };

      // Bow distribution only means something once the player has actually
      // changed direction a few times — one long stroke isn't "short bow".
      const shortUsage = usageIn(SHORT_BOW_WINDOW_S);
      if (shortUsage && strokesIn(SHORT_BOW_WINDOW_S) >= MIN_STROKES_FIX) {
        if (shortUsage.robustRange < THRESHOLDS.bow.minDistributionRange) found.push('short_bow');
      }

      const campedUsage = usageIn(CAMPED_WINDOW_S);
      if (campedUsage && strokesIn(CAMPED_WINDOW_S) >= MIN_STROKES_PRAISE) {
        const zone = campedUsage.campedZone;
        // Camping mid-bow isn't a "reach the tip/frog" problem — it's the same
        // "use more of the bow" message, so it reuses that cue.
        if (zone === 'lower' || zone === 'lower half') found.push('camped_lower');
        else if (zone === 'upper' || zone === 'upper half') found.push('camped_upper');
        else if (zone === 'middle' && !found.includes('short_bow')) found.push('short_bow');
      }

      // Deviation is measured against the running median for the whole take, the
      // same camera-agnostic baseline scoreBowAngle uses.
      if (angleHistory.length >= 20) {
        const baseline = median(angleHistory);
        const recentAngles = anglePts.filter((p) => p.t >= t - WOBBLE_WINDOW_S).map((p) => p.v);
        if (recentAngles.length >= 10) {
          const off = recentAngles.filter((a) => Math.abs(a - baseline) > THRESHOLDS.bow.angleDeviationDeg).length;
          if (off / recentAngles.length >= WOBBLE_BAD_SHARE) found.push('bow_wobble');
        }

        const steadyAngles = anglePts.filter((p) => p.t >= t - STEADY_BOW_WINDOW_S).map((p) => p.v);
        if (steadyAngles.length >= 15 && strokesIn(STEADY_BOW_WINDOW_S) >= MIN_STROKES_PRAISE) {
          const good = steadyAngles.filter((a) => Math.abs(a - baseline) <= THRESHOLDS.bow.angleDeviationDeg).length;
          if (good / steadyAngles.length >= PRAISE_GOOD_SHARE) found.push('steady_bow');
        }
      }

      const praiseUsage = usageIn(SHORT_BOW_WINDOW_S);
      if (praiseUsage && strokesIn(SHORT_BOW_WINDOW_S) >= MIN_STROKES_PRAISE) {
        if (praiseUsage.robustRange >= THRESHOLDS.bow.distributionFullRange && praiseUsage.campedZone === null) {
          found.push('full_bow');
        }
      }
    }

    // ── Pitch / tone ────────────────────────────────────────────────────────
    // With no rms stream (pre-rebuild native), fall back to frequency-only
    // voicing rather than going silent.
    const hasRms = snap.rms.length === snap.pitchHz.length && snap.rms.length > 0;
    const voiced = snap.pitchHz.map((hz, i) => hz != null && (!hasRms || snap.rms[i] >= PLAYING_RMS));

    const run = latestVoicedRun(snap.pitchHz, voiced);

    // Vibrato praise is judged on the note being held right now, not the window.
    // Pushed ahead of in_tune so a genuine vibrato — the more notable moment —
    // wins the one praise slot when the note is both centred and oscillating.
    if (isSustainedVibrato(currentNoteSegment(run))) found.push('good_vibrato');

    if (run.length >= PITCH_OFF_MIN_S * PITCH_HZ) {
      const cents = run.map(centsFromNearestNote);
      const centerCents = median(cents);
      const spread = median(cents.map((c) => Math.abs(c - centerCents)));
      // A wide spread means a slide or a scale run passing through — the note
      // isn't settled anywhere, so "sharp"/"flat" would be meaningless.
      if (spread <= PITCH_OFF_MAX_SPREAD) {
        if (centerCents >= PITCH_OFF_CENTS) found.push('pitch_sharp');
        else if (centerCents <= -PITCH_OFF_CENTS) found.push('pitch_flat');
        else if (
          run.length >= IN_TUNE_MIN_S * PITCH_HZ &&
          Math.abs(centerCents) <= IN_TUNE_CENTS
        ) {
          found.push('in_tune');
        }
      }
    }

    if (hasRms) {
      const loud = snap.rms.filter((_, i) => voiced[i]);
      if (loud.length >= EVEN_TONE_MIN_S * PITCH_HZ) {
        const avg = mean(loud);
        const cv = Math.sqrt(mean(loud.map((v) => (v - avg) ** 2))) / (avg || 1);
        if (cv < EVEN_TONE_MAX_CV) found.push('even_tone');
      }
    }

    // ── Sound quality (scratch / thin) ───────────────────────────────────────
    // Needs both the loudness and the tonality streams. Judged over a recent
    // window that must be mostly voiced (continuous sound), so the roughness is
    // the tone itself, not a bow change.
    const hasClarity = snap.clarity.length === snap.pitchHz.length && snap.clarity.length > 0;
    if (hasRms && hasClarity) {
      const n = snap.pitchHz.length;
      const from = Math.max(0, n - Math.round(TONE_WINDOW_S * PITCH_HZ));
      const voicedIdx: number[] = [];
      for (let i = from; i < n; i++) if (voiced[i]) voicedIdx.push(i);
      if (voicedIdx.length >= TONE_MIN_VOICED_FRAMES) {
        const roughShare = voicedIdx.filter((i) => snap.clarity[i] < TONE_ROUGH_CLARITY).length / voicedIdx.length;
        if (roughShare >= TONE_ROUGH_SHARE) {
          const avgRms = mean(voicedIdx.map((i) => snap.rms[i]));
          found.push(avgRms >= TONE_SCRATCH_RMS ? 'tone_scratchy' : 'tone_thin');
        }
      }
    }

    return found;
  };

  const cueFor = (id: CueId): LiveCue => ({ id, ...LIVE_CUES[id] });

  const tick = (snap: LiveSnapshot): LiveCue | null => {
    const { t } = snap;
    const candidates = detect(snap);
    const kindsOf = (kind: CueKind) => candidates.filter((id) => LIVE_CUES[id].kind === kind);
    const setups = kindsOf('setup');
    const fixes = kindsOf('fix');

    // A showing cue holds the screen for its full display time — the one
    // exception is a setup problem, which makes everything else moot.
    if (current) {
      if (setups.length > 0 && current.cue.kind !== 'setup') {
        const cue = cueFor(setups[0]);
        current = { cue, shownAt: t };
        lastShownAt.set(cue.id, t);
        lastAnyShownAt = t;
        return cue;
      }
      // A setup problem stays on screen until it is actually resolved. Timing it
      // out would make it blink on and off for as long as the player is out of
      // frame, which reads as a glitch rather than an instruction.
      if (current.cue.kind === 'setup' && candidates.includes(current.cue.id)) return current.cue;
      if (t - current.shownAt < MIN_DISPLAY_S) return current.cue;
      lastDismissedAt = t;
      current = null;
      return null;
    }

    if (t - lastDismissedAt < MIN_GAP_S) return null;

    // Setup cues bypass the grace period and the rate limit: the take is being
    // wasted until they're resolved, so the player needs to know immediately.
    let chosen: CueId | null = setups[0] ?? null;

    if (!chosen) {
      if (t < GRACE_S) return null;
      if (t - lastAnyShownAt < GLOBAL_MIN_INTERVAL_S) return null;

      // Nothing is judged while the room is quiet — a player resting between
      // passages is not making mistakes.
      const recentRms = ringTail(snap.rms, SILENCE_WINDOW_S);
      const recentPitch = ringTail(snap.pitchHz, SILENCE_WINDOW_S);
      const playing = recentRms.length > 0
        ? recentRms.some((v) => v >= PLAYING_RMS)
        : recentPitch.some((hz) => hz != null);
      if (!playing) return null;

      const offCooldown = (id: CueId, cooldown: number) => t - (lastShownAt.get(id) ?? -Infinity) >= cooldown;
      // Whichever eligible cue has gone unsaid longest. Repeating one message
      // while a second goes unmentioned is how a coach becomes a nag.
      const leastRecent = (ids: CueId[]) =>
        ids.reduce<CueId | null>((best, id) => {
          if (!best) return id;
          return (lastShownAt.get(id) ?? -Infinity) < (lastShownAt.get(best) ?? -Infinity) ? id : best;
        }, null);

      if (fixes.length > 0) {
        chosen = leastRecent(fixes.filter((id) => offCooldown(id, FIX_COOLDOWN_S)));
      } else {
        // Praise only when nothing at all needs fixing — including fixes that
        // are merely on cooldown. "Nice vibrato" while the wrist is collapsed
        // teaches the wrong thing.
        chosen = leastRecent(kindsOf('praise').filter((id) => offCooldown(id, PRAISE_COOLDOWN_S)));
      }
    }

    if (!chosen) return null;

    const cue = cueFor(chosen);
    current = { cue, shownAt: t };
    lastShownAt.set(cue.id, t);
    lastAnyShownAt = t;
    return cue;
  };

  return { tick, reset };
}
