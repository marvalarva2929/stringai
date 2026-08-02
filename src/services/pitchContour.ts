/**
 * Pure pitch-contour analysis: vibrato classification and intonation stability.
 *
 * Extracted from audioEngine so it can be exercised by unit tests under plain Node
 * (audioEngine pulls in Expo-only modules). No native/Expo dependencies here — only
 * ./dsp helpers and analysis types.
 */

import { severityFromScore } from '../types/analysis';
import type { MetricScore, FlaggedTimestamp, IntonationFaultType, IntonationStabilityNoteResult, IntonationStabilityAnalysis, VibratoNoteResult } from '../types/analysis';
import { clamp, centsFromNearestNote } from './dsp';
import type { PitchFrame } from './dsp';
import { frequencyToNoteInfo } from '../lib/intonationAnalysis';

// Vibrato detection thresholds
export const VIBRATO_MIN_SEGMENT_S   = 0.5;  // needs n≥20 frames so lagMax≥13 covers full 3–8 Hz range
export const VIBRATO_MIN_FRAMES      = 20;   // enforced alongside VIBRATO_MIN_SEGMENT_S
const VIBRATO_RATE_MIN_HZ     = 3;    // below 3 Hz = slow trembling, not vibrato
const VIBRATO_RATE_MAX_HZ     = 8;    // above 8 Hz = unusually fast / tense
const VIBRATO_DEPTH_MIN_CENTS = 8;    // oscillation must reach at least ±8 cents to count
// Scoring shape constants — adjust these to tune leniency
const VIBRATO_DEPTH_SWEET_LOW  = 18;  // cents below which depthScore ramps from 35→60
const VIBRATO_DEPTH_SWEET_HIGH = 40;  // cents above which depthScore is capped at 100
const VIBRATO_RATE_CENTER_HZ   = 5.5; // ideal rate; sweet spot ±1.5 Hz, slope 20/Hz beyond
const VIBRATO_AC_THRESHOLD_NORMAL = 0.22; // periodicity gate for full-length segments
const VIBRATO_AC_THRESHOLD_SHORT  = 0.12; // relaxed gate for segments < 2 vibrato cycles
const VIBRATO_CONSISTENCY_MAX  = 0.75; // cvMAD above this → inconsistency flag
const THIRD_LABELS = ['first', 'second', 'last'] as const;

// Intonation-stability thresholds. avgStd is the drift of the (vibrato-detrended) pitch
// center, much smaller than the old raw-deviation std. Calibrated 2026-06 against 16 usable
// real clips (npm run calibrate:intonation): steady playing clustered at 0.5–5¢ (median ~4),
// genuine instability at 10–17¢ — center-line drift is a compressed scale, so a few cents
// separates good from poor. Steady clips occasionally contain one ~16¢ note (a residual
// slide / short-note vibrato leak), so the per-note flag sits above that to avoid false flags.
const STABILITY_SCORE_SLOPE  = 5.0; // score = 100 − avgStd·slope (steady→75–98, unstable→15–50)
const STABILITY_FLAG_CENTS   = 17;  // per-note center drift above which the note is flagged (severe)
const STABILITY_ATTENTION_CENTS = 9; // per-note drift above which a note is surfaced as "unsteady"
const STABILITY_STEADY_CENTS = 5;   // avgStd below this → "very steadily"
const STABILITY_SLIGHT_CENTS = 10;  // avgStd below this → "slight drift"; above → "significant"
const STABILITY_MAX_CARDS    = 6;   // cap on surfaced per-note cards

// Centered moving average. With a window of one vibrato cycle this acts as a boxcar
// filter whose first spectral null sits exactly on the vibrato rate, so a clean periodic
// vibrato collapses to a flat center line while slower pitch drift passes through.
function smoothCenterLine(devs: number[], win: number): number[] {
  const half = Math.floor(win / 2);
  return devs.map((_, i) => {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(devs.length - 1, i + half); j++) { sum += devs[j]; cnt++; }
    return sum / cnt;
  });
}

/**
 * Raw intonation-stability statistics, before mapping to a 0–100 score. Exposed so the
 * calibration harness can read the underlying center-line drift (cents) directly rather
 * than reverse-engineering it from the score.
 *   • insufficient — fewer than 3 voiced frames
 *   • short        — too few notes to segment; stdCents is the smoothed global drift
 *   • no-notes     — notes existed but none had a long-enough stable core
 *   • per-note     — avgStd = mean center-line drift (cents) across assessed notes
 */
// Raw per-note stability measurement (no naming / fault labels — those are presentation,
// applied in scoreIntonationStability).
export interface PerNoteStability {
  startS: number;
  endS: number;
  medFreq: number;       // note's own median frequency (reference)
  driftCents: number;    // center-line std — the stability measure
  framesStable: number;  // count of assessed (post-attack) frames
  cents: number[];       // raw deviation from the note median
  centerCents: number[]; // vibrato-removed center line
}

export type IntonationStabilityStats =
  | { mode: 'insufficient' }
  | { mode: 'short'; stdCents: number }
  | { mode: 'no-notes' }
  | { mode: 'per-note'; avgStd: number; notes: PerNoteStability[] };

export function computeIntonationStability(pitches: PitchFrame[]): IntonationStabilityStats {
  const detected = pitches.filter((p) => p.frequency !== null) as { frequency: number; timestamp: number }[];
  if (detected.length < 3) return { mode: 'insufficient' };

  // Pitch-frame rate (≈40 Hz for the 25 ms detector hop). Derived from the median frame
  // spacing so the vibrato-cycle window stays correct if the hop ever changes.
  const diffs: number[] = [];
  for (let i = 1; i < detected.length; i++) {
    const dt = detected[i].timestamp - detected[i - 1].timestamp;
    if (dt > 0 && dt < 0.1) diffs.push(dt); // ignore inter-note gaps
  }
  diffs.sort((a, b) => a - b);
  const medianDt = diffs.length > 0 ? diffs[Math.floor(diffs.length / 2)] : 0.025;
  const hopHz = 1 / medianDt;

  // Window (frames) that nulls a detected vibrato; falls back to light smoothing that only
  // removes YIN frame-to-frame jitter on plain notes.
  const centerLineWindow = (devs: number[], lightWin: number): number[] => {
    const vib = classifyVibratoSegment(devs, hopHz);
    const win =
      vib.isVibrato && vib.rate >= VIBRATO_RATE_MIN_HZ && vib.rate <= VIBRATO_RATE_MAX_HZ
        ? Math.min(devs.length, Math.max(3, Math.round(hopHz / vib.rate)))
        : Math.min(devs.length, lightWin);
    return smoothCenterLine(devs, win);
  };

  // Segment into individual notes: a note = consecutive frames clustered around ONE pitch.
  // Split when a frame departs from the running median of the current segment, or on a
  // silence gap. Comparing to the running median (not just the previous frame) is what keeps
  // legato/slurred passages from being glued into one "note": a slow slide between two
  // pitches steps <NOTE_JUMP_CENTS per frame but lands far from where the note started, so
  // a previous-frame test would never break it and the whole slur would read as instability.
  // Vibrato (±~50¢ around the median) stays well inside the threshold and is not split.
  // The old approach computed global stdDev of cents-from-ET, which conflated between-note
  // pitch changes with within-note drift (10 stable notes at 10 pitches scored poorly).
  const NOTE_JUMP_CENTS = 70;   // cents from the segment's running median → new note
  const NOTE_GAP_S      = 0.25; // silence gap → new note
  const ATTACK_SKIP_S   = 0.12; // ignore first 120ms of each note (bow attack transient)
  const MIN_FRAMES      = 4;    // minimum stable frames needed to assess a note

  const medianFreq = (frames: { frequency: number }[]): number => {
    const s = frames.map((f) => f.frequency).sort((a, b) => a - b);
    return s[Math.floor(s.length / 2)];
  };

  const noteSegments: { frequency: number; timestamp: number }[][] = [];
  let current: { frequency: number; timestamp: number }[] = [detected[0]];
  for (let i = 1; i < detected.length; i++) {
    const curr = detected[i];
    const centsFromMed = Math.abs(1200 * Math.log2(curr.frequency / medianFreq(current)));
    const timeDiff     = curr.timestamp - detected[i - 1].timestamp;
    if (centsFromMed > NOTE_JUMP_CENTS || timeDiff > NOTE_GAP_S) {
      if (current.length >= MIN_FRAMES) noteSegments.push(current);
      current = [curr];
    } else {
      current.push(curr);
    }
  }
  if (current.length >= MIN_FRAMES) noteSegments.push(current);

  // Fall back to the smoothed global analysis for clips too short to segment.
  // Same vibrato-aware center-line treatment as the per-note path below.
  if (noteSegments.length === 0) {
    const devs = detected.map((p) => centsFromNearestNote(p.frequency!));
    const smoothed = centerLineWindow(devs, 21);
    const mean = smoothed.reduce((a, b) => a + b, 0) / smoothed.length;
    const variance = smoothed.reduce((acc, d) => acc + (d - mean) ** 2, 0) / smoothed.length;
    const stdCents = Math.sqrt(variance);
    return { mode: 'short', stdCents };
  }

  // Per-note stability: measure pitch drift within each note's stable core.
  // Use the note's own median frequency as reference — not the ET pitch —
  // so that consistently-tuned-but-not-ET notes aren't penalized.
  const notes: PerNoteStability[] = [];

  for (const seg of noteSegments) {
    const segStart = seg[0].timestamp;
    const stableFrames = seg.filter((f) => f.timestamp - segStart > ATTACK_SKIP_S);
    if (stableFrames.length < 3) continue;

    // Median frequency — robust to outlier frames (string squeaks, brief slides)
    const sorted = [...stableFrames].sort((a, b) => a.frequency - b.frequency);
    const medFreq = sorted[Math.floor(sorted.length / 2)].frequency;

    const devs = stableFrames.map((f) => 1200 * Math.log2(f.frequency / medFreq));

    // Measure the steadiness of the note's pitch CENTER, not its instantaneous deviation.
    // A deliberate vibrato is a periodic wobble that must not count as instability, so we
    // detrend it (smooth over one vibrato cycle) before taking the std. Genuine slow drift —
    // scooping, an unsteady held pitch — survives the smoothing and is still measured.
    const centerLine = centerLineWindow(devs, 5);
    const mean = centerLine.reduce((a, b) => a + b, 0) / centerLine.length;
    const variance = centerLine.reduce((acc, d) => acc + (d - mean) ** 2, 0) / centerLine.length;
    const stdCents = Math.sqrt(variance);

    notes.push({
      startS: segStart,
      endS: seg[seg.length - 1].timestamp,
      medFreq,
      driftCents: stdCents,
      framesStable: stableFrames.length,
      cents: devs,
      centerCents: centerLine,
    });
  }

  if (notes.length === 0) return { mode: 'no-notes' };

  const avgStd = notes.reduce((a, n) => a + n.driftCents, 0) / notes.length;
  return { mode: 'per-note', avgStd, notes };
}

// Classify the KIND of within-note instability from the (vibrato-removed) center line:
// a dominant linear trend → the pitch drifted sharp/flat as it sustained; a far-off start that
// settles → the player scooped into the note; otherwise an irregular waver.
function classifyInstability(center: number[]): IntonationFaultType {
  const n = center.length;
  if (n < 3) return 'waver';
  const xMean = (n - 1) / 2;
  const yMean = center.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xMean) * (center[i] - yMean); den += (i - xMean) ** 2; }
  const slope = den > 0 ? num / den : 0;
  const trendCents = slope * (n - 1); // total rise (+) / fall (−) across the note
  let resVar = 0;
  for (let i = 0; i < n; i++) { const fit = yMean + slope * (i - xMean); resVar += (center[i] - fit) ** 2; }
  const residStd = Math.sqrt(resVar / n);

  const DRIFT_MIN_CENTS = 12;
  if (Math.abs(trendCents) >= DRIFT_MIN_CENTS && Math.abs(trendCents) >= residStd * 1.5) {
    return trendCents > 0 ? 'drift_sharp' : 'drift_flat';
  }
  const q = Math.max(1, Math.floor(n / 4));
  const firstMean = center.slice(0, q).reduce((a, b) => a + b, 0) / q;
  const restMean = center.slice(q).reduce((a, b) => a + b, 0) / Math.max(1, n - q);
  if (Math.abs(firstMean - restMean) >= 15) return 'scoop';
  return 'waver';
}

const FAULT_LABEL: Record<IntonationFaultType, string> = {
  drift_sharp: 'drifted sharp', drift_flat: 'drifted flat', scoop: 'scooped into pitch', waver: 'wavered',
};

function stabilityFeedback(noteName: string, fault: IntonationFaultType): string {
  switch (fault) {
    case 'drift_sharp': return `${noteName} crept sharp as it sustained — keep steady left-hand finger pressure and a relaxed hand.`;
    case 'drift_flat':  return `${noteName} sagged flat as it sustained — support the pitch with consistent finger contact.`;
    case 'scoop':       return `${noteName} slid into pitch — aim the finger to land on the note, not below it.`;
    case 'waver':       return `${noteName} wavered in pitch — even out bow speed and pressure and keep the hand relaxed.`;
  }
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

const round1 = (x: number) => Math.round(x * 10) / 10;
const EMPTY_STABILITY_ANALYSIS: IntonationStabilityAnalysis = { assessedCount: 0, unsteadyCount: 0, avgDriftCents: 0, worstNotes: [] };

export function scoreIntonationStability(
  pitches: PitchFrame[],
): { metric: MetricScore; analysis: IntonationStabilityAnalysis } {
  const stats = computeIntonationStability(pitches);

  if (stats.mode === 'insufficient') {
    return { metric: { key: 'intonationStability', score: 60, flaggedTimestamps: [], severity: severityFromScore(60), events: [], occurrenceRate: 0, observationSummary: 'Insufficient notes to assess pitch stability.' }, analysis: EMPTY_STABILITY_ANALYSIS };
  }
  if (stats.mode === 'no-notes') {
    return { metric: { key: 'intonationStability', score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0, observationSummary: 'Notes were too short to assess individual pitch stability.' }, analysis: EMPTY_STABILITY_ANALYSIS };
  }
  if (stats.mode === 'short') {
    const score = clamp(Math.round(100 - stats.stdCents * STABILITY_SCORE_SLOPE));
    return { metric: { key: 'intonationStability', score, flaggedTimestamps: [], severity: severityFromScore(score), events: [], occurrenceRate: Math.min(1, stats.stdCents / 25), observationSummary: 'Pitch stability assessed from short clip.' }, analysis: EMPTY_STABILITY_ANALYSIS };
  }

  const { avgStd, notes } = stats;
  const score = clamp(Math.round(100 - avgStd * STABILITY_SCORE_SLOPE));
  const occurrenceRate = Math.min(1, avgStd / 20);

  // Build per-note results (name + fault + actionable feedback).
  const results: IntonationStabilityNoteResult[] = notes.map((n) => {
    const noteName = frequencyToNoteInfo(n.medFreq).noteName;
    const faultType = classifyInstability(n.centerCents);
    return {
      startS: round1(n.startS),
      endS: round1(n.endS),
      noteName,
      driftCents: Math.round(n.driftCents),
      noteScore: clamp(Math.round(100 - n.driftCents * STABILITY_SCORE_SLOPE)),
      faultType,
      feedbackNote: stabilityFeedback(noteName, faultType),
      cents: n.cents.map(round1),
      centerCents: n.centerCents.map(round1),
    };
  });

  // "Unsteady" notes (above the attention threshold), worst-first, capped for display.
  const worstNotes = results
    .filter((_, i) => notes[i].driftCents > STABILITY_ATTENTION_CENTS)
    .sort((a, b) => b.driftCents - a.driftCents)
    .slice(0, STABILITY_MAX_CARDS);

  const analysis: IntonationStabilityAnalysis = {
    assessedCount: results.length,
    unsteadyCount: results.filter((_, i) => notes[i].driftCents > STABILITY_ATTENTION_CENTS).length,
    avgDriftCents: round1(avgStd),
    worstNotes,
  };

  // Severe notes feed the session timeline (flaggedTimestamps), now with note name + fault.
  const flagged: FlaggedTimestamp[] = notes
    .map((n, i) => ({ n, r: results[i] }))
    .filter(({ n }) => n.driftCents > STABILITY_FLAG_CENTS && n.framesStable >= 6)
    .map(({ n, r }) => ({ startSeconds: n.startS, endSeconds: n.endS, note: `${r.noteName} ${FAULT_LABEL[r.faultType]} (±${Math.round(n.driftCents)}¢)` }))
    .slice(0, 4);

  // Observation summary — name the worst offenders when present.
  let observationSummary: string;
  if (worstNotes.length === 0) {
    observationSummary =
      avgStd < STABILITY_STEADY_CENTS
        ? 'Sustained notes held their pitch center very steadily.'
        : `Slight drift in the pitch center of held notes (avg ±${Math.round(avgStd)}¢) — mostly steady.`;
  } else {
    const named = worstNotes.slice(0, 2).map((w) => `${w.noteName} ${FAULT_LABEL[w.faultType]} at ${fmtTime(w.startS)}`).join(', ');
    const tip = avgStd >= STABILITY_SLIGHT_CENTS
      ? 'Focus on a steady left hand and even bow speed.'
      : 'Worth steadying the left hand on held notes.';
    const count = worstNotes.length;
    observationSummary = `${count} ${count === 1 ? 'note was' : 'notes were'} unsteady in pitch — ${named}. ${tip}`;
  }

  return { metric: { key: 'intonationStability', score, flaggedTimestamps: flagged, severity: severityFromScore(score), events: [], occurrenceRate, observationSummary }, analysis };
}

/**
 * Classifies a single pitch segment as vibrato or not.
 * devs: cents deviation from median, one value per pitch frame.
 * hopHz: pitch sampling rate (40 for upload YIN, 20 for live autocorrelation).
 */
export function classifyVibratoSegment(
  devs: number[],
  hopHz: number,
): { rate: number; depth: number; periodicityScore: number; consistencyOk: boolean; feedbackNotes: string[]; noteScore: number; isVibrato: boolean } {
  const n = devs.length;
  // Clip at ±150¢ before any statistics — real vibrato never exceeds ~±50¢ and YIN octave
  // errors (±1200¢) would otherwise explode both variance and autocorrelation.
  const CLIP = 150;
  const clipped = devs.map((d) => Math.max(-CLIP, Math.min(CLIP, d)));
  const mean = clipped.reduce((a, b) => a + b, 0) / n;
  const variance = clipped.reduce((acc, d) => acc + (d - mean) ** 2, 0) / n;
  const depth = Math.sqrt(variance) * Math.SQRT2;

  if (depth < VIBRATO_DEPTH_MIN_CENTS) {
    return { rate: 0, depth, periodicityScore: 0, consistencyOk: true, feedbackNotes: ['no vibrato detected'], noteScore: 0, isVibrato: false };
  }

  // Normalized autocorrelation across lags corresponding to 3–8 Hz (use clipped signal)
  const lagMin = Math.max(2, Math.round(hopHz / VIBRATO_RATE_MAX_HZ));
  const lagMax = Math.min(n - 2, Math.round(hopHz / VIBRATO_RATE_MIN_HZ));
  let bestLag = lagMin, bestAC = -Infinity;
  for (let lag = lagMin; lag <= lagMax; lag++) {
    let sum = 0;
    for (let i = 0; i < n - lag; i++) sum += (clipped[i] - mean) * (clipped[i + lag] - mean);
    const ac = sum / ((n - lag) * variance);
    if (ac > bestAC) { bestAC = ac; bestLag = lag; }
  }
  const rate = hopHz / bestLag;
  const periodicityScore = Math.max(0, bestAC);

  // Thirds consistency (use clipped signal)
  const third = Math.max(1, Math.floor(n / 3));
  const thirdMADs = [0, 1, 2].map((t) => {
    const sl = clipped.slice(t * third, (t + 1) * third);
    if (sl.length === 0) return 0;
    const sliceMean = sl.reduce((a, d) => a + d, 0) / sl.length;
    return sl.reduce((a, d) => a + Math.abs(d - sliceMean), 0) / sl.length;
  });
  const meanMAD = thirdMADs.reduce((a, b) => a + b) / 3;
  const cvMAD = Math.sqrt(thirdMADs.reduce((acc, m) => acc + (m - meanMAD) ** 2, 0) / 3) / (meanMAD + 0.1);
  const consistencyOk = cvMAD < VIBRATO_CONSISTENCY_MAX;
  const dominantThird = thirdMADs.indexOf(Math.max(...thirdMADs));

  // Short segments have few AC pairs — lower the gate and let depth carry more weight
  const minCycleFrames = Math.round(hopHz / VIBRATO_RATE_MIN_HZ);
  const acThreshold = n < 2 * minCycleFrames ? VIBRATO_AC_THRESHOLD_SHORT : VIBRATO_AC_THRESHOLD_NORMAL;

  // Rate gate — must be computed before the early returns below
  const rateInRange = rate >= VIBRATO_RATE_MIN_HZ && rate <= VIBRATO_RATE_MAX_HZ;

  // Hard gate only when the note clearly cannot be vibrato:
  //   • rate is out of the 3–8 Hz range, OR
  //   • AC is very low AND depth is marginal (likely noise / no real oscillation).
  // A note with good depth AND in-range rate IS real vibrato even if irregular —
  // AC = 0 for genuinely uneven human vibrato should score ~60, not 20.
  // The scoring formula below handles low AC naturally via periodicityNorm = 0.
  if (!rateInRange || (periodicityScore < 0.05 && depth < VIBRATO_DEPTH_MIN_CENTS * 2)) {
    return { rate, depth, periodicityScore, consistencyOk, feedbackNotes: ['vibrato rhythm is too uneven to measure — try for a steadier wrist motion'], noteScore: 20, isVibrato: false };
  }

  // Feedback strings — multiple issues can apply to one note; thresholds are intentionally lenient
  const feedbackNotes: string[] = [];
  if (depth < 12)                                feedbackNotes.push('vibrato depth is a bit shallow — try a slightly wider bow-arm motion');
  if (periodicityScore < VIBRATO_AC_THRESHOLD_NORMAL) feedbackNotes.push('vibrato rhythm is uneven — focus on a steady, relaxed wrist motion');
  if (cvMAD > VIBRATO_CONSISTENCY_MAX)           feedbackNotes.push(`vibrato fades in the ${THIRD_LABELS[dominantThird]} third — aim for even depth throughout the bow stroke`);
  if (rate < 4.0)                                feedbackNotes.push('vibrato rate is a bit slow — try a slightly faster impulse from the wrist');
  if (rate > 7.5)                                feedbackNotes.push('vibrato is a touch fast — try relaxing the arm and broadening the motion');

  // Component scores (each 0–100)
  // depthScore: floor of 35 for any measurable vibrato; generous in the 18–40 cent sweet spot
  const depthScore =
    depth < VIBRATO_DEPTH_SWEET_LOW
      ? Math.max(35, ((depth - VIBRATO_DEPTH_MIN_CENTS) / (VIBRATO_DEPTH_SWEET_LOW - VIBRATO_DEPTH_MIN_CENTS)) * 55)
      : depth < VIBRATO_DEPTH_SWEET_HIGH
        ? 60 + ((depth - VIBRATO_DEPTH_SWEET_LOW) / (VIBRATO_DEPTH_SWEET_HIGH - VIBRATO_DEPTH_SWEET_LOW)) * 40
        : 100;
  // rateScore: sweet spot ±1.5 Hz around center (4.0–7.0 Hz gets full marks), gentle 20/Hz slope beyond
  const rateScore       = clamp(100 - Math.max(0, Math.abs(rate - VIBRATO_RATE_CENTER_HZ) - 1.5) * 20);
  const periodicityNorm = clamp((periodicityScore / 0.5) * 100);
  // consistencyNorm: soft penalty — good vibrato still scores well at moderate cvMAD values
  const consistencyNorm = clamp((1 - cvMAD / 0.9) * 100);

  // depth weighted highest (most perceptually salient for violin)
  const noteScore = Math.round(
    0.35 * depthScore +
    0.25 * periodicityNorm +
    0.20 * consistencyNorm +
    0.20 * rateScore,
  );

  // isVibrato is a presence flag — requires AC above threshold for a clean positive signal
  const isVibrato = rateInRange && periodicityScore >= acThreshold;

  return { rate, depth, periodicityScore, consistencyOk, feedbackNotes, noteScore, isVibrato };
}

// ─── UI-facing vibrato fault classification ──────────────────────────────────
// The persisted VibratoNoteResult drops isVibrato/cvMAD, so the UI re-derives
// faults from the surviving numeric fields. Lives here (not in the component)
// so the classification shares this module's thresholds and stays Node-testable.

export type VibratoFault = 'none' | 'shallow' | 'wide' | 'slow' | 'fast' | 'uneven' | 'fades';

/** Axis/band numbers for "you vs target" displays — same constants the scorer uses. */
export const VIBRATO_DISPLAY = {
  RATE_AXIS_MIN: VIBRATO_RATE_MIN_HZ,
  RATE_AXIS_MAX: VIBRATO_RATE_MAX_HZ,
  // rateScore's full-marks band: VIBRATO_RATE_CENTER_HZ ± 1.5. The engine's
  // "touch fast" feedback string fires at 7.5, but the score sweet spot — and
  // therefore this classification — ends at 7.0.
  RATE_TARGET_LO: VIBRATO_RATE_CENTER_HZ - 1.5,
  RATE_TARGET_HI: VIBRATO_RATE_CENTER_HZ + 1.5,
  DEPTH_MIN: VIBRATO_DEPTH_MIN_CENTS,
  DEPTH_TARGET_LO: VIBRATO_DEPTH_SWEET_LOW,
  DEPTH_TARGET_HI: VIBRATO_DEPTH_SWEET_HIGH,
} as const;

/** True when a persisted note actually contained measurable vibrato. */
export function hasVibrato(note: { rateHz: number; depthCents: number }): boolean {
  return note.rateHz >= VIBRATO_RATE_MIN_HZ &&
         note.rateHz <= VIBRATO_RATE_MAX_HZ &&
         note.depthCents >= VIBRATO_DEPTH_MIN_CENTS;
}

/**
 * Classifies a persisted note's vibrato faults from its numeric metrics.
 * Returns faults in priority order ([0] is the primary fault); [] = healthy.
 * Priority: presence > measurability > depth > rate > periodicity > consistency
 * (depth first because depthScore carries the highest noteScore weight).
 */
export function classifyVibratoFaults(note: {
  rateHz: number;
  depthCents: number;
  periodicityScore: number;
  consistencyOk: boolean;
}): VibratoFault[] {
  // Depth-gate early return in classifyVibratoSegment: rate 0, depth below minimum.
  if (note.rateHz === 0 || note.depthCents < VIBRATO_DEPTH_MIN_CENTS) return ['none'];
  // Hard-gate case: rate outside 3–8 Hz means the oscillation couldn't be
  // measured as vibrato — its rate/depth numbers are unreliable, report only this.
  if (note.rateHz < VIBRATO_RATE_MIN_HZ || note.rateHz > VIBRATO_RATE_MAX_HZ) return ['uneven'];

  const faults: VibratoFault[] = [];
  if (note.depthCents < VIBRATO_DEPTH_SWEET_LOW) faults.push('shallow');
  else if (note.depthCents > VIBRATO_DEPTH_SWEET_HIGH) faults.push('wide');
  if (note.rateHz < VIBRATO_DISPLAY.RATE_TARGET_LO) faults.push('slow');
  else if (note.rateHz > VIBRATO_DISPLAY.RATE_TARGET_HI) faults.push('fast');
  if (note.periodicityScore < VIBRATO_AC_THRESHOLD_NORMAL) faults.push('uneven');
  if (!note.consistencyOk) faults.push('fades');
  return faults;
}

/**
 * Segments a pitch track into vibrato-eligible notes and classifies each one.
 * Splits on the provided onsets, or falls back to a pitch-jump/time-gap rule
 * when none are given. Returns [] when there isn't enough sustained pitch data
 * — callers decide what "not enough" means for their own messaging.
 */
export function segmentVibratoNotes(pitches: PitchFrame[], onsets?: number[]): VibratoNoteResult[] {
  const detected = pitches.filter((p) => p.frequency !== null) as { frequency: number; timestamp: number; periodicity?: number }[];
  if (detected.length < VIBRATO_MIN_FRAMES) return [];
  const audioDuration = detected[detected.length - 1].timestamp;

  type SegWithBounds = { frames: typeof detected; startS: number; endS: number };
  let allSegs: SegWithBounds[];
  if (onsets && onsets.length > 0) {
    allSegs = onsets.map((startS, i) => {
      const endS = onsets[i + 1] ?? audioDuration;
      return { startS, endS, frames: detected.filter((f) => f.timestamp >= startS && f.timestamp < endS) };
    });
  } else {
    const rawSegs: (typeof detected)[] = [];
    let current: typeof detected = [detected[0]];
    for (let i = 1; i < detected.length; i++) {
      const prev = detected[i - 1];
      const curr = detected[i];
      const centsDiff = Math.abs(1200 * Math.log2(curr.frequency / prev.frequency));
      const timeDiff = curr.timestamp - prev.timestamp;
      if (centsDiff > 100 || timeDiff > 0.2) { rawSegs.push(current); current = [curr]; }
      else current.push(curr);
    }
    rawSegs.push(current);
    allSegs = rawSegs.map((frames) => ({ frames, startS: frames[0].timestamp, endS: frames[frames.length - 1].timestamp }));
  }

  const eligible = allSegs.filter((seg) => {
    const dur = seg.endS - seg.startS;
    return dur >= VIBRATO_MIN_SEGMENT_S && seg.frames.length >= VIBRATO_MIN_FRAMES;
  });

  return eligible.map((seg) => {
    const freqs = seg.frames.map((f) => f.frequency);
    const sorted = [...freqs].sort((a, b) => a - b);
    const medianFreq = sorted[Math.floor(sorted.length / 2)];
    // Octave-correct each frame before computing cents deviation.
    // YIN sometimes returns a frequency an octave too high or too low; without this,
    // a single octave-flipped frame contributes ±1200¢ to the variance and destroys
    // the depth and autocorrelation calculations.
    const corrected = freqs.map((f) => {
      const dist = Math.abs(1200 * Math.log2(f / medianFreq));
      if (dist <= 600) return f;
      const halfDist   = Math.abs(1200 * Math.log2((f / 2) / medianFreq));
      const doubleDist = Math.abs(1200 * Math.log2((f * 2) / medianFreq));
      if (halfDist < dist && halfDist <= doubleDist) return f / 2;
      if (doubleDist < dist) return f * 2;
      return f;
    });
    const devs = corrected.map((f) => 1200 * Math.log2(f / medianFreq));
    const result = classifyVibratoSegment(devs, 40);
    return {
      startS: Math.round(seg.startS * 100) / 100,
      endS: Math.round(seg.endS * 100) / 100,
      durationS: Math.round((seg.endS - seg.startS) * 100) / 100,
      noteScore: result.noteScore,
      rateHz: Math.round(result.rate * 10) / 10,
      depthCents: Math.round(result.depth * 10) / 10,
      periodicityScore: Math.round(result.periodicityScore * 100) / 100,
      consistencyOk: result.consistencyOk,
      feedbackNotes: result.feedbackNotes,
      cents: devs.map((c) => Math.round(c * 10) / 10),
    };
  });
}
