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
// Long enough to cover the metronome click (CLICK_DURATION_S = 0.014) and its
// decay, short enough not to swallow the start of the note answering it.
const CLICK_BLANK_S = 0.04;

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
    // Blank out the click, then judge the rest of the beat. This used to skip a
    // proportion of the interval (15%), which at 60 BPM threw away the first
    // 150ms of every note to dodge a 14ms click (lib/clickTone.ts) — and when
    // that left nothing voiced, the note was reported as "not detected" even
    // though the player had clearly played it. A fixed blank covers the click
    // with room to spare and costs a fraction as much real audio.
    const windowStart = beatT + Math.min(CLICK_BLANK_S, interval * 0.15);
    const windowEnd = beatT + interval * 0.9;
    const windowFrames = frames.filter((f) => f.frequency !== null && f.timestamp >= windowStart && f.timestamp < windowEnd);
    // Where the note actually started relative to its click, so the score can
    // weigh timing. Deliberately starts *at* the beat: this path judges legato
    // scales where the previous note is still sounding, so the first voiced
    // frame before the beat belongs to that note, not to an onset. Correcting
    // the late bias of the audio chain is the rhythm path's job, where onsets
    // come from voiced runs bounded by real silence (rhythmAttemptsFromBeats).
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

/** Amplitude-envelope resolution for onset picking. */
const ONSET_HOP_S = 0.005;
/** Two bow strokes closer together than this are one stroke. */
const ONSET_MIN_IOI_S = 0.12;
/** Local window for the adaptive threshold, in envelope frames (±150ms). */
const ONSET_MEDIAN_WIN = 30;
/** How far above the local median a rise has to be to count as an attack. */
const ONSET_MULTIPLIER = 2.2;
/** Absolute floor, as a fraction of the take's loudest rise — kills noise-floor jitter. */
const ONSET_DELTA_FRAC = 0.08;
/** A real note keeps sounding after its attack; a click does not. */
const ONSET_SUSTAIN_S = 0.15;
/**
 * Median-filter width applied to the envelope before differencing, in frames
 * (45ms). A median filter deletes any impulse shorter than half its window while
 * leaving a sustained step edge exactly where it was — so the 14ms metronome
 * click vanishes and the note's attack keeps its timing. A moving *average*
 * would smear the attack later instead, which is the one direction this whole
 * path must not drift.
 */
const ONSET_SMOOTH_FRAMES = 9;

/**
 * Note attacks, from the amplitude envelope.
 *
 * This used to take the start of each voiced pitch run, which silently required
 * 150ms of *silence* between notes to see them as separate. Real playing does not
 * do that: keep the bow on the string, or play anything close to legato, and
 * every note in the take merges into one run — eight notes at 80 BPM became a
 * single onset, and the drill reported no attack near any click. A bow change
 * re-attacks the envelope even when the pitch never stops sounding, so that is
 * what gets measured here.
 *
 * It is also more accurate. A voiced-run start is quantized to the 25ms pitch hop
 * and lands only once YIN has ~23ms of established periodicity, so it trails the
 * real attack — always late, never early. The envelope resolves to 5ms and rises
 * with the bow.
 *
 * The metronome click is excluded by requiring the attack to be followed by
 * sustained voiced audio: the click is a 14ms aperiodic tick that produces no
 * voiced frame at all (see lib/clickTone.ts CLICK_Q), so nothing sustains behind
 * it. A note played *on* the click merges with it, which is correct — that is the
 * player's note.
 */
function onsetsFromEnvelope(
  samples: Float32Array,
  sampleRate: number,
  frames: PitchFrame[],
): { time: number; confidence: number; freqHz: number }[] {
  const hop = Math.max(1, Math.floor(sampleRate * ONSET_HOP_S));
  const env: number[] = [];
  for (let i = 0; i + hop <= samples.length; i += hop) {
    let sum = 0;
    for (let k = i; k < i + hop; k++) sum += samples[k] * samples[k];
    env.push(Math.sqrt(sum / hop));
  }
  if (env.length < 3) return [];

  // Median-filter out the click before looking for attacks. Without this the
  // click's own transient is the largest rise at every beat, wins the peak pick,
  // and every note reports an offset of 0ms — the drill would be grading the
  // metronome against itself.
  const half = ONSET_SMOOTH_FRAMES >> 1;
  const smooth: number[] = [];
  for (let i = 0; i < env.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(env.length, i + half + 1);
    const win = env.slice(lo, hi).sort((a, b) => a - b);
    smooth.push(win[Math.floor(win.length / 2)]);
  }

  // Half-wave rectified first difference: energy going up, which is what an
  // attack is. Falling energy is a release and must not register.
  const rise: number[] = [0];
  for (let i = 1; i < smooth.length; i++) rise.push(Math.max(0, smooth[i] - smooth[i - 1]));

  const maxRise = Math.max(...rise);
  if (maxRise <= 0) return [];
  const floor = maxRise * ONSET_DELTA_FRAC;

  const candidates: number[] = [];
  for (let i = 1; i < rise.length - 1; i++) {
    if (rise[i] < floor) continue;
    if (rise[i] < rise[i - 1] || rise[i] < rise[i + 1]) continue; // local peak only

    const lo = Math.max(0, i - ONSET_MEDIAN_WIN);
    const hi = Math.min(rise.length, i + ONSET_MEDIAN_WIN);
    const local = rise.slice(lo, hi).sort((a, b) => a - b);
    const median = local[Math.floor(local.length / 2)];
    if (rise[i] < median * ONSET_MULTIPLIER) continue;

    candidates.push(i);
  }

  // Keep the strongest rise inside each minimum-inter-onset window.
  const minGapFrames = Math.max(1, Math.round(ONSET_MIN_IOI_S / ONSET_HOP_S));
  const picked: number[] = [];
  for (const i of candidates) {
    const prev = picked[picked.length - 1];
    if (prev != null && i - prev < minGapFrames) {
      if (rise[i] > rise[prev]) picked[picked.length - 1] = i;
      continue;
    }
    picked.push(i);
  }

  // Confirm each attack is a note: voiced pitch has to persist behind it.
  const out: { time: number; confidence: number; freqHz: number }[] = [];
  for (const i of picked) {
    const time = (i * hop) / sampleRate;
    const sustained = frames.filter(
      (f) => f.frequency !== null && f.timestamp >= time - ONSET_HOP_S && f.timestamp <= time + ONSET_SUSTAIN_S,
    );
    if (sustained.length < MIN_ATTEMPT_FRAMES) continue;
    const freqs = sustained.map((f) => f.frequency!).sort((a, b) => a - b);
    out.push({
      time,
      confidence: sustained.reduce((sum, f) => sum + (f.periodicity ?? 0), 0) / sustained.length,
      freqHz: freqs[Math.floor(freqs.length / 2)],
    });
  }
  return out;
}

// One judged attempt per click: finds the nearest note attack (if any) within
// half a beat interval of that click, so a slightly early or late attack still
// counts as an answer to that click rather than its neighbor's.
function rhythmAttemptsFromBeats(samples: Float32Array, sampleRate: number, beatTimestamps: number[]): RhythmAttempt[] {
  // Unlike scaleAttemptsFromBeats, this can't skip the frames right at the beat —
  // that is exactly where a well-timed note is supposed to land.
  const frames = detectPitches(samples, sampleRate);
  const onsets = onsetsFromEnvelope(samples, sampleRate, frames);

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
