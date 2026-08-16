/**
 * Per-phrase dynamic shaping — the musical half of dynamics analysis.
 *
 * Extracted from `services/audioEngine.ts` `scoreDynamicControl`, which ran its
 * own private phrase segmentation (silence gate 0.015, minimum 3s, no
 * subdivision). That disagreed with the L6 segmentation in `noteFusion.ts`
 * (gate 0.008, minimum 0.5s, subdivided on RMS minima + bow speed + onsets) —
 * the one `PhraseFeatures.id` is keyed on and the one the results UI seeks to.
 *
 * Two consequences, both bad:
 *   - "phrase 3" meant different music in the two systems, so a shape
 *     observation could never be tied to a phrase id the UI could seek to
 *     without landing on the wrong passage.
 *   - The 3s floor discarded short phrases entirely. At ~120bpm in 3/4 a 2-bar
 *     sub-phrase is about 3s, so the richest signal here — `melodic_contour`,
 *     RMS correlated against pitch slope — never existed for exactly the short
 *     phrases a student most needs shaping help with.
 *
 * This module takes the L6 phrases as given, so there is now one segmentation.
 *
 * Note it computes *no score*: `dynamicControl`'s score is jitter + range +
 * a sliding-2s-window R², all phrase-independent, and stays in audioEngine.
 * Only which moments get flagged changes.
 *
 * Pure and dependency-free so it runs under the Node test harness, matching
 * `phraseFeatures.ts` and `scoring.ts`.
 */

import type { PhraseShape } from '../types/analysis';

export interface RmsFrame { value: number; timestamp: number }
export interface PitchFrameLike { frequency: number | null; timestamp: number }
export interface PhraseWindow { start: number; end: number }

/** Per-phrase dynamic shaping, keyed to the L6 phrase id the UI seeks with. */
export interface PhraseDynamics {
  phraseId: number;
  startSec: number;
  endSec: number;
  /** Squared coefficient of variation — how much the level moves at all. */
  cv2: number;
  /** Linear slope normalised by the phrase's own range. */
  slopeNorm: number;
  /** 0-1 position of the loudest moment within the phrase. */
  peakPos: number;
  /** Absolute time of that peak, for feedback that can be seeked to. */
  peakSec: number;
  shape: PhraseShape;
  /** True when level and pitch trend together — shaping the line, not a fault. */
  melodicContour: boolean;
}

export interface DynamicsIssue {
  type:
    | 'dyn_narrow_range'
    | 'dyn_flat_phrase'
    | 'dyn_flat_phrases'
    | 'dyn_inverted_phrase'
    | 'dyn_peak_early'
    | 'dyn_peak_late'
    | 'dyn_fade_over_session';
  startSec: number;
  endSec: number;
  confidence: number;
  note: string;
  /** Set for phrase-scoped issues so the UI and the model can seek to it. */
  phraseId?: number;
}

export interface DynamicsShapeResult {
  phraseRows: PhraseDynamics[];
  issues: DynamicsIssue[];
  /** Loudest-to-quietest contrast across the session. */
  dynamicRatio: number;
}

// Thresholds carried over unchanged from audioEngine so behaviour is
// comparable; only the windows they run on have changed.
const SILENCE_GATE = 0.015;
const FLAT_CV2 = 0.004;
const INV_SLOPE_NORM = -0.2;
const RISING_SLOPE = 0.15;
const PEAK_EARLY = 0.15;
const PEAK_LATE = 0.82;
const CONSEC_FALLING = 3;
const SMOOTH_SECONDS = 0.25;
/**
 * Pitch trend, in cents per second, that counts as a deliberate melodic
 * direction — roughly a semitone per 1.25s. Time-based so it does not silently
 * change meaning if the analysis frame rate does.
 */
const MELODIC_CENTS_PER_SEC = 80;
/** Below this a phrase has too few samples for a slope to mean anything. */
const MIN_FRAMES_PER_PHRASE = 4;

const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** 250ms centred moving average — the envelope shaping is judged on. */
function smooth(frames: RmsFrame[], seconds: number): number[] {
  if (frames.length < 2) return frames.map((f) => f.value);
  const hopS = Math.max(1e-6, (frames[frames.length - 1].timestamp - frames[0].timestamp) / (frames.length - 1));
  const win = Math.max(1, Math.round(seconds / hopS));
  const out = new Array<number>(frames.length);
  for (let i = 0; i < frames.length; i++) {
    let sum = 0;
    let count = 0;
    for (let j = Math.max(0, i - win); j <= Math.min(frames.length - 1, i + win); j++) {
      sum += frames[j].value;
      count++;
    }
    out[i] = sum / count;
  }
  return out;
}

/** Least-squares slope of y against its index. Null when undetermined. */
function slopeOf(values: number[]): number | null {
  return slopeAgainst(values.map((_, i) => i), values);
}

/** Least-squares slope of y against arbitrary x. Null when undetermined. */
function slopeAgainst(xs: number[], ys: number[]): number | null {
  const n = ys.length;
  if (n < 2 || xs.length !== n) return null;
  let sx = 0;
  let sy = 0;
  let sxy = 0;
  let sx2 = 0;
  for (let j = 0; j < n; j++) {
    sx += xs[j];
    sy += ys[j];
    sxy += xs[j] * ys[j];
    sx2 += xs[j] * xs[j];
  }
  const den = n * sx2 - sx * sx;
  return den !== 0 ? (n * sxy - sx * sy) / den : null;
}

function classifyShape(cv2: number, slopeNorm: number, peakPos: number): PhraseShape {
  if (cv2 < FLAT_CV2) return 'plateau';
  if (slopeNorm >= RISING_SLOPE && peakPos > 0.55) return 'rising';
  if (slopeNorm <= INV_SLOPE_NORM && peakPos < 0.45) return 'falling';
  if (peakPos >= 0.2 && peakPos <= 0.8) return 'arch';
  return 'unclassified';
}

/**
 * Pitch trend across a window, in **cents per second**. A phrase whose level
 * rises with its pitch is shaping a rising line, not making a dynamics mistake.
 *
 * The original computed this per *frame index* and compared against 50, which at
 * a 50 Hz frame rate demanded 2500 cents/sec — over two octaves per second. No
 * melodic line moves that fast, so `melodic_contour` could effectively never
 * fire and genuinely well-shaped rising phrases were being flagged as dynamics
 * faults. Measuring against time makes the threshold frame-rate independent and
 * musically meaningful.
 */
function pitchSlopeOver(pitchFrames: PitchFrameLike[] | undefined, startSec: number, endSec: number): number | null {
  if (!pitchFrames) return null;
  const inWindow = pitchFrames.filter(
    (p) => p.frequency !== null && p.timestamp >= startSec && p.timestamp <= endSec,
  );
  if (inWindow.length < 4) return null;
  return slopeAgainst(
    inWindow.map((p) => p.timestamp),
    inWindow.map((p) => 1200 * Math.log2(p.frequency! / 440)),
  );
}

export function computeDynamicsShape(
  phrases: PhraseWindow[],
  rmsFrames: RmsFrame[],
  pitchFrames?: PitchFrameLike[],
): DynamicsShapeResult {
  const empty: DynamicsShapeResult = { phraseRows: [], issues: [], dynamicRatio: 1 };
  if (rmsFrames.length < 10) return empty;

  const slow = smooth(rmsFrames, SMOOTH_SECONDS);
  const playing = slow.filter((v) => v > SILENCE_GATE);
  if (playing.length < 10) return empty;

  const dynamicRatio = Math.max(...playing) / Math.max(Math.min(...playing), 0.001);
  const sessionEnd = rmsFrames[rmsFrames.length - 1].timestamp;

  const issues: DynamicsIssue[] = [];

  // Objective and phrase-independent — never suppressed.
  if (dynamicRatio < 2.5) {
    const r = dynamicRatio.toFixed(1);
    issues.push({
      type: 'dyn_narrow_range',
      startSec: 0,
      endSec: sessionEnd,
      confidence: 1 - Math.max(0, dynamicRatio - 1) / 1.5,
      note:
        dynamicRatio < 2
          ? `Dynamic range is very narrow (${r}× contrast) — try a full, heavy bow for forte and a light touch for piano. Aim for 5× or more.`
          : `Dynamic range is limited (${r}× contrast) — push the contrast between your softest and loudest moments.`,
    });
  }

  const phraseRows: PhraseDynamics[] = [];
  const flatPhrases: { startSec: number; endSec: number; phraseId: number }[] = [];
  let consecutiveFalling = 0;
  let fallingRunStart = -1;

  phrases.forEach((phrase, phraseId) => {
    // Frames inside the phrase window, by timestamp — the L6 phrases are in
    // seconds, so there is no shared frame index to slice on.
    const idx: number[] = [];
    for (let i = 0; i < rmsFrames.length; i++) {
      const t = rmsFrames[i].timestamp;
      if (t >= phrase.start && t <= phrase.end) idx.push(i);
    }
    if (idx.length < MIN_FRAMES_PER_PHRASE) return;

    const arr = idx.map((i) => slow[i]);
    const n = arr.length;
    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const cv2 = variance / (mean * mean + 1e-10);
    const range = Math.max(...arr) - Math.min(...arr);

    const rawSlope = slopeOf(arr) ?? 0;
    const slopeNorm = (rawSlope * n) / (range + 1e-8);

    let peakIdx = 0;
    for (let j = 1; j < n; j++) if (arr[j] > arr[peakIdx]) peakIdx = j;
    const peakPos = n > 1 ? peakIdx / (n - 1) : 0;
    const peakSec = rmsFrames[idx[peakIdx]].timestamp;

    const startSec = phrase.start;
    const endSec = phrase.end;

    let shape = classifyShape(cv2, slopeNorm, peakPos);

    // Level and pitch moving together is a shaped line, not a fault.
    let melodicContour = false;
    const pSlope = pitchSlopeOver(pitchFrames, startSec, endSec);
    if (pSlope !== null && shape !== 'plateau') {
      const rmsDir = rawSlope > 0 ? 1 : rawSlope < 0 ? -1 : 0;
      const pitchDir = pSlope > MELODIC_CENTS_PER_SEC ? 1 : pSlope < -MELODIC_CENTS_PER_SEC ? -1 : 0;
      if (rmsDir !== 0 && rmsDir === pitchDir) {
        shape = 'melodic_contour';
        melodicContour = true;
      }
    }

    phraseRows.push({ phraseId, startSec, endSec, cv2, slopeNorm, peakPos, peakSec, shape, melodicContour });

    if (shape === 'falling') {
      consecutiveFalling++;
      if (consecutiveFalling === 1) fallingRunStart = startSec;
    } else {
      consecutiveFalling = 0;
      fallingRunStart = -1;
    }

    if (shape === 'plateau') {
      flatPhrases.push({ startSec, endSec, phraseId });
      return;
    }

    // One falling phrase is a diminuendo; a run of them is a habit.
    if (shape === 'falling') {
      if (consecutiveFalling === CONSEC_FALLING) {
        issues.push({
          type: 'dyn_inverted_phrase',
          startSec: fallingRunStart,
          endSec,
          phraseId,
          confidence: 0.5,
          note: `${consecutiveFalling} phrases in a row are fading out — at ${fmtT(fallingRunStart)}, try letting at least one phrase build or hold steady.`,
        });
      }
      return;
    }

    // rising / arch / melodic_contour are all valid shaping — never flagged.
    if (shape !== 'unclassified') return;

    if (peakPos < PEAK_EARLY) {
      const confidence = Math.min(1, ((PEAK_EARLY - peakPos) / PEAK_EARLY) * 1.5);
      if (confidence >= 0.3) {
        issues.push({
          type: 'dyn_peak_early',
          startSec,
          endSec,
          phraseId,
          confidence,
          note: `At ${fmtT(startSec)}, you peaked at ${fmtT(peakSec)} — very early in the phrase. Save the climax for later.`,
        });
      }
    } else if (peakPos > PEAK_LATE && slopeNorm > 0.1) {
      const confidence = Math.min(1, ((peakPos - PEAK_LATE) / (1 - PEAK_LATE)) * 1.5);
      if (confidence >= 0.3) {
        issues.push({
          type: 'dyn_peak_late',
          startSec,
          endSec,
          phraseId,
          confidence,
          note: `At ${fmtT(startSec)}, volume keeps building right to the end of the phrase at ${fmtT(endSec)} — try leveling off earlier.`,
        });
      }
    }
  });

  // A few flat phrases is a passage; many is the whole performance.
  if (flatPhrases.length >= 3) {
    issues.push({
      type: 'dyn_flat_phrases',
      startSec: flatPhrases[0].startSec,
      endSec: flatPhrases[flatPhrases.length - 1].endSec,
      confidence: Math.min(1, flatPhrases.length / 4),
      note: `${flatPhrases.length} phrases in a row sound flat in volume — add shape to each: build toward a peak or taper at the end.`,
    });
  } else {
    for (const fp of flatPhrases) {
      issues.push({
        type: 'dyn_flat_phrase',
        startSec: fp.startSec,
        endSec: fp.endSec,
        phraseId: fp.phraseId,
        confidence: 0.4 + 0.1 * flatPhrases.length,
        note: `The phrase at ${fmtT(fp.startSec)}–${fmtT(fp.endSec)} sounds flat in volume — add shape by building toward a peak or tapering at the end.`,
      });
    }
  }

  // Energy draining across the session, measured on phrase means.
  if (phraseRows.length >= 4) {
    const means = phraseRows.map((row) => {
      const vals: number[] = [];
      for (let i = 0; i < rmsFrames.length; i++) {
        const t = rmsFrames[i].timestamp;
        if (t >= row.startSec && t <= row.endSec && slow[i] > SILENCE_GATE) vals.push(slow[i]);
      }
      return vals.length > 0 ? vals.reduce((a, b) => a + b, 0) / vals.length : 0;
    });
    const slope = slopeOf(means);
    const avg = means.reduce((a, b) => a + b, 0) / means.length;
    if (slope !== null && avg > 0) {
      const normSlope = slope / (avg + 1e-10);
      if (normSlope < -0.04) {
        issues.push({
          type: 'dyn_fade_over_session',
          startSec: 0,
          endSec: sessionEnd,
          confidence: Math.min(1, Math.abs(normSlope) / 0.08),
          note: 'Your volume gradually fades over the session — stay physically engaged and keep bow-arm energy in the second half.',
        });
      }
    }
  }

  return { phraseRows, issues, dynamicRatio };
}

/** Highest-confidence issues first, capped. Mirrors the old ranking. */
export function rankDynamicsIssues(issues: DynamicsIssue[], max = 5): DynamicsIssue[] {
  return issues
    .filter((e) => e.confidence >= 0.3)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, max);
}
