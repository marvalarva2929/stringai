import { detectPitches, centsFromNearestNote, type PitchFrame } from '../services/dsp';
import { segmentVibratoNotes } from '../services/pitchContour';
import {
  evaluatePitchLanding,
  evaluateVibrato,
  type PitchAttempt,
  type VibratoAttempt,
  type PracticeEvaluation,
} from './practiceEvaluator';
import { evaluateToneFault } from './toneFaultEvaluator';
import { evaluateBowGeometry } from './bowGeometryEvaluator';
import { evaluateDynamicsShape } from './dynamicsEvaluator';
import { evaluateHold, type HoldAttempt } from './holdEvaluator';
import { evaluateScale, type ScaleAttempt } from './scaleEvaluator';
import { evaluateRhythm, type RhythmAttempt } from './rhythmEvaluator';
import { scaleNoteSequence } from './scaleSequence';
import { useCalibrationStore } from '../store/useCalibrationStore';
import type { EvaluatorParams } from './practiceBlocks';
import type { RawBowFrame } from '../types/signals';

/** A judged take: decoded audio for mic-only exercises, raw bow frames for camera ones. */
export interface CapturedTake {
  samples?: Float32Array;
  sampleRate?: number;
  rawBowFrames?: RawBowFrame[];
  /** Metronome beat times (seconds since recording start), for 'scale' takes —
   *  lets the analysis read each beat's known window instead of guessing note
   *  boundaries from silence gaps. */
  beatTimestamps?: number[];
}

// Silence gap long enough to mean "the player stopped the bow" — separates one
// note attempt from the next in stop-start exercises (Note Landing Trainer etc).
const ATTEMPT_GAP_S = 0.15;
// ~100ms of voiced audio minimum before a segment counts as a real attempt,
// filtering out brief noise blips that briefly cross the YIN pitch threshold.
const MIN_ATTEMPT_FRAMES = 4;

// The metronome's click is a synthesized pure tone (see useMetronome.ts's
// buildClickWav) played right at each beat — exactly where a well-timed note
// is also expected to land. If it bleeds acoustically into the mic (room
// reverb, a phone speaker close to the mic), YIN can lock onto it as a
// "voiced" pitch and it gets misread as the player's attack. Both click-paced
// evaluators (scale, rhythm) filter it out by its known frequency.
const CLICK_HZ = 1000;
const CLICK_EXCLUDE_CENTS = 35;
function isClickPitch(freqHz: number): boolean {
  return Math.abs(1200 * Math.log2(freqHz / CLICK_HZ)) <= CLICK_EXCLUDE_CENTS;
}

// Splits detected pitch frames into voiced runs, one per note attempt/hold —
// separated by a >150ms silence gap (the player stopping the bow).
function segmentVoicedRuns(frames: PitchFrame[]): PitchFrame[][] {
  const segments: PitchFrame[][] = [];
  let current: PitchFrame[] = [];
  let lastVoicedTs: number | null = null;

  for (const frame of frames) {
    if (frame.frequency === null) continue;
    if (lastVoicedTs !== null && frame.timestamp - lastVoicedTs > ATTEMPT_GAP_S && current.length > 0) {
      segments.push(current);
      current = [];
    }
    current.push(frame);
    lastVoicedTs = frame.timestamp;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function attemptsFromSamples(samples: Float32Array, sampleRate: number): PitchAttempt[] {
  const frames = detectPitches(samples, sampleRate);
  return segmentVoicedRuns(frames)
    .filter((seg) => seg.length >= MIN_ATTEMPT_FRAMES)
    .map((seg) => {
      const cents = seg.map((f) => centsFromNearestNote(f.frequency!)).sort((a, b) => a - b);
      const medianCents = cents[Math.floor(cents.length / 2)];
      const avgPeriodicity = seg.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / seg.length;
      return {
        centsDeviation: medianCents,
        confidence: avgPeriodicity,
        startTimeSeconds: seg[0].timestamp,
        endTimeSeconds: seg[seg.length - 1].timestamp,
      };
    });
}

// Unlike attemptsFromSamples (one median cents value per segment, for a clean
// attack), this keeps every frame so a hold can be judged by how much of its
// own duration stayed in tolerance, not collapsed to a single number.
function holdAttemptsFromSamples(samples: Float32Array, sampleRate: number, centsThreshold: number): HoldAttempt[] {
  const frames = detectPitches(samples, sampleRate);
  return segmentVoicedRuns(frames)
    .filter((seg) => seg.length >= MIN_ATTEMPT_FRAMES)
    .map((seg) => {
      const cents = seg.map((f) => centsFromNearestNote(f.frequency!));
      const meanCentsDeviation = cents.reduce((a, b) => a + b, 0) / cents.length;
      const inTolerance = cents.filter((c) => Math.abs(c) <= centsThreshold).length;
      const avgPeriodicity = seg.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / seg.length;
      return {
        durationSeconds: seg[seg.length - 1].timestamp - seg[0].timestamp,
        fractionInTolerance: inTolerance / cents.length,
        meanCentsDeviation,
        confidence: avgPeriodicity,
        startTimeSeconds: seg[0].timestamp,
        endTimeSeconds: seg[seg.length - 1].timestamp,
      };
    });
}

// Nulls out any frame pitched at the metronome click's own frequency, so it
// can't be picked up as a voiced note by callers that segment on frequency !== null.
function withoutClickFrames(frames: PitchFrame[]): PitchFrame[] {
  return frames.map((f) => (f.frequency !== null && isClickPitch(f.frequency) ? { ...f, frequency: null } : f));
}

// Fallback when beat timestamps aren't available: one entry per silence-gap
// segment, in order — median detected frequency per segment.
function scaleAttemptsFromSamples(samples: Float32Array, sampleRate: number): ScaleAttempt[] {
  const frames = withoutClickFrames(detectPitches(samples, sampleRate));
  return segmentVoicedRuns(frames)
    .filter((seg) => seg.length >= MIN_ATTEMPT_FRAMES)
    .map((seg) => {
      const freqs = seg.map((f) => f.frequency!).sort((a, b) => a - b);
      const avgPeriodicity = seg.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / seg.length;
      return {
        medianFreqHz: freqs[Math.floor(freqs.length / 2)],
        confidence: avgPeriodicity,
        startTimeSeconds: seg[0].timestamp,
        endTimeSeconds: seg[seg.length - 1].timestamp,
      };
    });
}

// Preferred path: the metronome tells us exactly when each beat fired, so we
// read each beat's own window directly instead of inferring note boundaries
// from silence gaps — robust to a player who doesn't fully stop between notes.
function scaleAttemptsFromBeats(samples: Float32Array, sampleRate: number, beatTimestamps: number[]): ScaleAttempt[] {
  const frames = withoutClickFrames(detectPitches(samples, sampleRate));
  const avgInterval = beatTimestamps.length > 1
    ? (beatTimestamps[beatTimestamps.length - 1] - beatTimestamps[0]) / (beatTimestamps.length - 1)
    : 1;

  return beatTimestamps.map((beatT, i) => {
    const nextT = beatTimestamps[i + 1] ?? beatT + avgInterval;
    const interval = nextT - beatT;
    // Skip the click's attack transient; stop short of the next click bleeding in.
    const windowStart = beatT + interval * 0.15;
    const windowEnd = beatT + interval * 0.9;
    const windowFrames = frames.filter((f) => f.frequency !== null && f.timestamp >= windowStart && f.timestamp < windowEnd);
    // Playback uses the full beat window (not the trimmed analysis window
    // above), so replaying a degree includes its attack instead of just the
    // steady-state slice that gets judged.
    const playback = { startTimeSeconds: beatT, endTimeSeconds: nextT };

    if (windowFrames.length === 0) return { medianFreqHz: 0, confidence: 0, ...playback };
    const freqs = windowFrames.map((f) => f.frequency!).sort((a, b) => a - b);
    const avgPeriodicity = windowFrames.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / windowFrames.length;
    return { medianFreqHz: freqs[Math.floor(freqs.length / 2)], confidence: avgPeriodicity, ...playback };
  });
}

// One judged attempt per click: finds the nearest note attack (if any) within
// half a beat interval of that click, so a slightly early or late attack still
// counts as an answer to that click rather than its neighbor's.
function rhythmAttemptsFromBeats(samples: Float32Array, sampleRate: number, beatTimestamps: number[]): RhythmAttempt[] {
  // Unlike scaleAttemptsFromBeats, this can't just skip the frames right at
  // the beat (that's exactly where a well-timed note is supposed to land) —
  // so the click is filtered by its known frequency instead, per-onset.
  const frames = detectPitches(samples, sampleRate);
  const onsets = segmentVoicedRuns(frames)
    .filter((seg) => seg.length >= MIN_ATTEMPT_FRAMES)
    .map((seg) => {
      const freqs = seg.map((f) => f.frequency!).sort((a, b) => a - b);
      return {
        time: seg[0].timestamp,
        confidence: seg.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / seg.length,
        freqHz: freqs[Math.floor(freqs.length / 2)],
      };
    })
    // Drop the metronome's own click bleeding into the mic — left in, it
    // would register as a perfectly-on-time "note" on every single beat.
    .filter((onset) => !isClickPitch(onset.freqHz));

  const avgInterval = beatTimestamps.length > 1
    ? (beatTimestamps[beatTimestamps.length - 1] - beatTimestamps[0]) / (beatTimestamps.length - 1)
    : 1;
  const window = avgInterval / 2;

  const claimed = new Set<number>();
  return beatTimestamps.map((beatT, i) => {
    const nextT = beatTimestamps[i + 1] ?? beatT + avgInterval;
    const playback = { startTimeSeconds: beatT, endTimeSeconds: nextT };

    let bestIdx = -1;
    let bestDist = Infinity;
    onsets.forEach((onset, idx) => {
      if (claimed.has(idx)) return;
      const dist = Math.abs(onset.time - beatT);
      if (dist > window || dist >= bestDist) return;
      bestIdx = idx;
      bestDist = dist;
    });

    if (bestIdx === -1) return { offsetMs: null, confidence: 0, ...playback };
    claimed.add(bestIdx);
    const best = onsets[bestIdx];
    return { offsetMs: (best.time - beatT) * 1000, confidence: best.confidence, ...playback };
  });
}

function vibratoAttemptsFromSamples(samples: Float32Array, sampleRate: number): VibratoAttempt[] {
  const pitches = detectPitches(samples, sampleRate);
  const notes = segmentVibratoNotes(pitches);
  return notes.map((note) => ({
    rateHz: note.rateHz,
    depthCents: note.depthCents,
    confidence: note.periodicityScore,
    durationSeconds: note.durationS,
  }));
}

const NO_TAKE_EVALUATION: PracticeEvaluation = {
  passed: false,
  attempts: 0,
  successCount: 0,
  bestStreak: 0,
  feedback: 'No take was captured — try again.',
};

const UNSUPPORTED_EVALUATION: PracticeEvaluation = {
  passed: false,
  attempts: 0,
  successCount: 0,
  bestStreak: 0,
  feedback: 'This exercise cannot be auto-judged yet.',
};

/**
 * Judges a captured take against a block's evaluator params. Returns null when
 * the block has no evaluator (self-report fallback, see ResultPhase).
 */
export function runEvaluator(
  params: EvaluatorParams | undefined,
  take: CapturedTake | null,
): PracticeEvaluation | null {
  if (!params) return null;
  if (!take) return NO_TAKE_EVALUATION;

  if (params.evaluatorId === 'bowGeometry') {
    return evaluateBowGeometry(take.rawBowFrames ?? [], useCalibrationStore.getState().calibration, params.target);
  }
  if (!take.samples || !take.sampleRate) return NO_TAKE_EVALUATION;

  switch (params.evaluatorId) {
    case 'pitchLanding':
      return evaluatePitchLanding(attemptsFromSamples(take.samples, take.sampleRate), params);
    case 'vibrato':
      return evaluateVibrato(vibratoAttemptsFromSamples(take.samples, take.sampleRate), params);
    case 'toneFault':
      return evaluateToneFault(take.samples, take.sampleRate, params);
    case 'dynamicsShape':
      return evaluateDynamicsShape(take.samples, take.sampleRate, params.target);
    case 'hold':
      return evaluateHold(holdAttemptsFromSamples(take.samples, take.sampleRate, params.centsThreshold), params);
    case 'scale': {
      const attempts = take.beatTimestamps && take.beatTimestamps.length > 0
        ? scaleAttemptsFromBeats(take.samples, take.sampleRate, take.beatTimestamps)
        : scaleAttemptsFromSamples(take.samples, take.sampleRate);
      return evaluateScale(attempts, scaleNoteSequence(params.scaleName, params.rootMidiNote), params);
    }
    case 'rhythm': {
      if (!take.beatTimestamps || take.beatTimestamps.length === 0) return NO_TAKE_EVALUATION;
      return evaluateRhythm(rhythmAttemptsFromBeats(take.samples, take.sampleRate, take.beatTimestamps), params);
    }
    default:
      return UNSUPPORTED_EVALUATION;
  }
}
