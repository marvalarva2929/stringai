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
import { evaluateTrill, type TrillAttempt } from './trillEvaluator';
import { evaluateAttack, type NoteEnvelope } from './attackEvaluator';
import { expectedNotesFor } from './sequenceSteps';
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

/**
 * A trill moves too fast for the 150ms silence-gap segmentation used elsewhere
 * — the notes never stop. Instead, each change of detected pitch is one
 * alternation, which is what the trill evaluator actually measures.
 */
function trillAttemptFromSamples(samples: Float32Array, sampleRate: number): TrillAttempt | null {
  const frames = detectPitches(samples, sampleRate)
    .filter((f) => f.frequency !== null);
  if (frames.length < MIN_ATTEMPT_FRAMES) return null;

  // Group consecutive frames that sit on the same semitone. A trill's two notes
  // are a semitone or a tone apart, so rounding to the nearest semitone is
  // exactly the resolution needed and it ignores the pitch smear at speed.
  const semitoneOf = (hz: number) => Math.round(69 + 12 * Math.log2(hz / 440));
  const onsetTimes: number[] = [];
  const medianFreqs: (number | null)[] = [];
  let currentSemitone: number | null = null;
  let group: number[] = [];

  const flush = (startTime: number) => {
    if (group.length === 0) return;
    const sorted = [...group].sort((a, b) => a - b);
    medianFreqs.push(sorted[Math.floor(sorted.length / 2)]);
    onsetTimes.push(startTime);
    group = [];
  };

  let groupStart = frames[0].timestamp;
  for (const frame of frames) {
    const semitone = semitoneOf(frame.frequency!);
    if (currentSemitone !== null && semitone !== currentSemitone) {
      flush(groupStart);
      groupStart = frame.timestamp;
    }
    currentSemitone = semitone;
    group.push(frame.frequency!);
  }
  flush(groupStart);

  if (onsetTimes.length < 2) return null;
  return {
    onsetTimes,
    medianFreqs,
    startTimeSeconds: frames[0].timestamp,
    endTimeSeconds: frames[frames.length - 1].timestamp,
  };
}

/**
 * Per-note amplitude envelopes for the stroke evaluator. Segmentation is by
 * RMS, not pitch — spiccato notes are short and airy enough that pitch tracking
 * drops them, and their silence is precisely the thing being measured.
 */
function envelopesFromSamples(samples: Float32Array, sampleRate: number): NoteEnvelope[] {
  const hopSize = Math.max(1, Math.floor(sampleRate * 0.005)); // 5ms resolution
  const rms: { t: number; v: number }[] = [];
  for (let i = 0; i + hopSize <= samples.length; i += hopSize) {
    let sum = 0;
    for (let k = i; k < i + hopSize; k++) sum += samples[k] * samples[k];
    rms.push({ t: i / sampleRate, v: Math.sqrt(sum / hopSize) });
  }
  if (rms.length === 0) return [];

  const peak = Math.max(...rms.map((r) => r.v));
  if (peak <= 0) return [];
  // Relative gate: a note is sounding while it is above a fraction of the
  // loudest thing in the take, so recording level doesn't change the verdict.
  const gate = peak * 0.12;

  const spans: { start: number; end: number; frames: { t: number; v: number }[] }[] = [];
  let current: { t: number; v: number }[] = [];
  for (const frame of rms) {
    if (frame.v >= gate) {
      current.push(frame);
    } else if (current.length > 0) {
      spans.push({ start: current[0].t, end: current[current.length - 1].t, frames: current });
      current = [];
    }
  }
  if (current.length > 0) {
    spans.push({ start: current[0].t, end: current[current.length - 1].t, frames: current });
  }

  // Anything this short is a click or a scrape, not a note.
  const notes = spans.filter((s) => s.end - s.start >= 0.03);

  return notes.map((span, i) => {
    let peakIndex = 0;
    for (let k = 1; k < span.frames.length; k++) {
      if (span.frames[k].v > span.frames[peakIndex].v) peakIndex = k;
    }
    const peakValue = span.frames[peakIndex].v;
    // "Sustain" is the body after the attack; for a very short note the whole
    // note is the body, which is the honest reading for spiccato.
    const body = span.frames.slice(peakIndex + 1);
    const sustain = body.length > 0
      ? body.reduce((s, f) => s + f.v, 0) / body.length
      : peakValue;
    const next = notes[i + 1];
    return {
      startSeconds: span.start,
      endSeconds: span.end,
      attackSeconds: span.frames[peakIndex].t - span.start,
      peakToSustain: sustain > 0 ? peakValue / sustain : 1,
      gapAfterSeconds: next ? next.start - span.end : 0,
    };
  });
}

// Fallback when beat timestamps aren't available: one entry per silence-gap
// segment, in order — median detected frequency per segment.
function scaleAttemptsFromSamples(samples: Float32Array, sampleRate: number): ScaleAttempt[] {
  const frames = detectPitches(samples, sampleRate);
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
  const frames = detectPitches(samples, sampleRate);
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
    // Where the note actually started relative to its click, so the score can
    // weigh timing. Taken from the first voiced frame in the wider beat window,
    // since the trimmed analysis window above deliberately skips the attack.
    const onsetFrame = frames.find((f) => f.frequency !== null && f.timestamp >= beatT && f.timestamp < nextT);
    const offsetMs = onsetFrame ? (onsetFrame.timestamp - beatT) * 1000 : null;
    // Playback uses the full beat window (not the trimmed analysis window
    // above), so replaying a degree includes its attack instead of just the
    // steady-state slice that gets judged.
    const playback = { startTimeSeconds: beatT, endTimeSeconds: nextT };

    if (windowFrames.length === 0) return { medianFreqHz: 0, confidence: 0, offsetMs, ...playback };
    const freqs = windowFrames.map((f) => f.frequency!).sort((a, b) => a - b);
    const avgPeriodicity = windowFrames.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / windowFrames.length;
    return { medianFreqHz: freqs[Math.floor(freqs.length / 2)], confidence: avgPeriodicity, offsetMs, ...playback };
  });
}

// One judged attempt per click: finds the nearest note attack (if any) within
// half a beat interval of that click, so a slightly early or late attack still
// counts as an answer to that click rather than its neighbor's.
function rhythmAttemptsFromBeats(samples: Float32Array, sampleRate: number, beatTimestamps: number[]): RhythmAttempt[] {
  // Unlike scaleAttemptsFromBeats, this can't skip the frames right at the beat —
  // that is exactly where a well-timed note is supposed to land. It doesn't need to:
  // onsets here come from voiced pitch runs, and the click is an aperiodic noise tick
  // that never produces a voiced frame (see lib/clickTone.ts), so it is absent from
  // this segmentation by construction rather than filtered out afterwards.
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
    });

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
    detected: note.detected,
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
    // Both paced drills grade the same way — attempt i against expected note i.
    // The only difference is where the expected list came from, which is why
    // sequenceSteps.ts owns that and neither case derives it itself.
    case 'scale':
    case 'sequence': {
      const attempts = take.beatTimestamps && take.beatTimestamps.length > 0
        ? scaleAttemptsFromBeats(take.samples, take.sampleRate, take.beatTimestamps)
        : scaleAttemptsFromSamples(take.samples, take.sampleRate);
      return evaluateScale(attempts, expectedNotesFor(params), params);
    }
    case 'rhythm': {
      if (!take.beatTimestamps || take.beatTimestamps.length === 0) return NO_TAKE_EVALUATION;
      return evaluateRhythm(rhythmAttemptsFromBeats(take.samples, take.sampleRate, take.beatTimestamps), params);
    }
    case 'trill':
      return evaluateTrill(trillAttemptFromSamples(take.samples, take.sampleRate), params);
    case 'attack':
      return evaluateAttack(envelopesFromSamples(take.samples, take.sampleRate), params);
    default:
      return UNSUPPORTED_EVALUATION;
  }
}
