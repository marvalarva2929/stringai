import type { RawAudioSignals, IntonationAnalysis, PitchClassIssue } from '../types/analysis';
import { POSE, HAND, CONFIDENCE_THRESHOLD, jointAngle, type FrameKeypoints } from './poseScoring';
import type { BowTimeSeries } from './bowAnalysis';
import type { TimeSeries, TimeSeriesPoint } from '../types/signals';

// ─────────────────────────────────────────────────────────────
// NoteEvent type
// ─────────────────────────────────────────────────────────────

export interface NoteEvent {
  // Timing
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;

  // Pitch identity
  pitchHz: number;
  noteName: string;                // e.g. "F#4"
  string: 'G' | 'D' | 'A' | 'E';
  inferredFinger: 0 | 1 | 2 | 3 | 4;
  positionGroup: 'first' | 'third' | 'fifth' | 'higher';

  // Pitch accuracy
  centsDeviation: number;          // signed: + = sharp, - = flat
  absCentsDeviation: number;
  inTune: boolean;                 // |cents| <= 25

  // Tone & dynamics
  fundamentalRatio: number;        // 0-1, FFT fundamental/total power
  dynamicLevel: number;            // 0-1, normalized RMS

  // Bow (from the bow detector via FuseSignalsOptions.bow; null when the bow
  // was not visible during the note. bowZone/distance need the bridge detector.)
  bowContactPoint: number | null;
  bowAngle: number | null;
  bowDistanceFromBridge: number | null;
  bowZone: 'sul_ponticello' | 'normal' | 'sul_tasto' | null;

  // Left hand / posture (null when pose frames unavailable)
  wristCollapsed: boolean | null;
  shoulderRaised: boolean | null;

  // Context
  distanceFromCrossing: number | null;  // notes since last string change (null if none in prev 5)
  phrasePosition: number;               // 0-1 within detected phrase
  phraseDurationSeconds: number;
}

// ─────────────────────────────────────────────────────────────
// Pitch helpers
// ─────────────────────────────────────────────────────────────

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiToName(midi: number): string {
  const pc = ((midi % 12) + 12) % 12;
  const oct = Math.floor(midi / 12) - 1;
  return NOTE_NAMES[pc] + oct;
}

function freqToMidiRaw(freq: number): number {
  return 12 * Math.log2(freq / 440) + 69;
}

function median(arr: number[]): number {
  if (arr.length === 0) return 0;
  const s = [...arr].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Violin string boundaries (open string freq to just below next open string)
const STRING_RANGES: { str: 'G' | 'D' | 'A' | 'E'; minHz: number }[] = [
  { str: 'E', minHz: 659 },
  { str: 'A', minHz: 440 },
  { str: 'D', minHz: 294 },
  { str: 'G', minHz: 0   },
];

function inferString(freq: number): 'G' | 'D' | 'A' | 'E' {
  for (const { str, minHz } of STRING_RANGES) {
    if (freq >= minHz) return str;
  }
  return 'G';
}

const OPEN_STRING_HZ: Record<'G' | 'D' | 'A' | 'E', number> = {
  G: 196.0,
  D: 293.7,
  A: 440.0,
  E: 659.3,
};

// Semitones above open string → first-position finger (approximate)
function inferFinger(freq: number, str: 'G' | 'D' | 'A' | 'E'): 0 | 1 | 2 | 3 | 4 {
  const semis = Math.max(0, Math.round(12 * Math.log2(freq / OPEN_STRING_HZ[str])));
  if (semis === 0) return 0;
  if (semis <= 2) return 1;
  if (semis <= 4) return 2;
  if (semis <= 6) return 3;
  return 4;
}

function positionGroupFromMidi(midi: number): 'first' | 'third' | 'fifth' | 'higher' {
  // Violin: first position tops out around B4 (MIDI 71), third ~E5 (76), fifth ~A5 (81)
  if (midi <= 71) return 'first';
  if (midi <= 76) return 'third';
  if (midi <= 81) return 'fifth';
  return 'higher';
}

// ─────────────────────────────────────────────────────────────
// Pose helpers
// ─────────────────────────────────────────────────────────────

function nearestPoseFrame(frames: FrameKeypoints[], t: number): FrameKeypoints | null {
  if (frames.length === 0) return null;
  let best = frames[0];
  let bestDiff = Math.abs(frames[0].timestamp - t);
  for (let i = 1; i < frames.length; i++) {
    const diff = Math.abs(frames[i].timestamp - t);
    if (diff < bestDiff) { best = frames[i]; bestDiff = diff; }
  }
  return bestDiff <= 2 ? best : null;
}

function getWristCollapsed(frame: FrameKeypoints): boolean | null {
  const pose = frame.poseLandmarks;
  const lh   = frame.leftHandLandmarks;
  if (!pose || !lh) return null;
  const elbow    = pose[POSE.LEFT_ELBOW];
  const wrist    = pose[POSE.LEFT_WRIST];
  const indexMcp = lh[HAND.INDEX_MCP];
  if (!elbow || !wrist || !indexMcp) return null;
  if ((elbow.visibility    ?? 1) < CONFIDENCE_THRESHOLD) return null;
  if ((wrist.visibility    ?? 1) < CONFIDENCE_THRESHOLD) return null;
  if ((indexMcp.visibility ?? 1) < CONFIDENCE_THRESHOLD) return null;
  return jointAngle(elbow, wrist, indexMcp) < 160;
}

function getShoulderRaised(frame: FrameKeypoints): boolean | null {
  const pose = frame.poseLandmarks;
  if (!pose) return null;
  const lS = pose[POSE.LEFT_SHOULDER], rS = pose[POSE.RIGHT_SHOULDER];
  if (!lS || !rS) return null;
  if ((lS.visibility !== undefined && lS.visibility < CONFIDENCE_THRESHOLD) ||
      (rS.visibility !== undefined && rS.visibility < CONFIDENCE_THRESHOLD)) return null;
  return Math.abs(lS.y - rS.y) > 0.04;
}

// Bow zone requires a bow detector — wrist-x proxy is unreliable from a front camera.
function getBowZone(_frame: FrameKeypoints): 'sul_ponticello' | 'normal' | 'sul_tasto' | null {
  return null;
}

// ─────────────────────────────────────────────────────────────
// Phrase detection (L6) — silence gaps + composite boundary score
// ─────────────────────────────────────────────────────────────

export interface Phrase { start: number; end: number; duration: number }

export interface DetectPhrasesOptions {
  /** Bow speed series — adds the bow_speed_drop term. */
  bowSpeed?: TimeSeries<number | null>;
  /** Onset timestamps — adds the inter_onset_gap term. */
  onsets?: number[];
}

const PHRASE_MIN_DURATION_S = 0.5;   // no segment shorter than this
const PHRASE_COMPOSITE_THRESHOLD = 0.6;
// Term weights, renormalized over whichever terms have usable data.
// With neither bow nor onsets available, the composite pass is a no-op and
// only the silence-gap segmentation (the historical behavior) applies.
const PHRASE_W_RMS = 0.5;
const PHRASE_W_BOW = 0.3;
const PHRASE_W_GAP = 0.2;
// Bow term is dropped when less than this fraction of samples are non-null.
const PHRASE_BOW_MIN_COVERAGE = 0.2;

export function detectPhrases(
  rmsFrames: { value: number; timestamp: number }[],
  opts?: DetectPhrasesOptions,
): Phrase[] {
  if (rmsFrames.length < 2) return [];
  const hopSec = (rmsFrames[rmsFrames.length - 1].timestamp - rmsFrames[0].timestamp) /
                 (rmsFrames.length - 1);
  // 500ms rolling average
  const halfWin = Math.max(1, Math.round(0.25 / hopSec));
  const smoothed = rmsFrames.map((_, i) => {
    const lo = Math.max(0, i - halfWin);
    const hi = Math.min(rmsFrames.length - 1, i + halfWin);
    let s = 0;
    for (let j = lo; j <= hi; j++) s += rmsFrames[j].value;
    return s / (hi - lo + 1);
  });

  const silenceThresh = 0.008;
  const minSilenceFrames = Math.max(1, Math.round(0.3 / hopSec));
  const phrases: Phrase[] = [];
  let phraseStart: number | null = null;
  let silenceRun = 0;

  for (let i = 0; i < smoothed.length; i++) {
    const t = rmsFrames[i].timestamp;
    if (smoothed[i] >= silenceThresh) {
      if (phraseStart === null) phraseStart = t;
      silenceRun = 0;
    } else {
      silenceRun++;
      if (phraseStart !== null && silenceRun >= minSilenceFrames) {
        const endIdx = Math.max(0, i - silenceRun);
        const end = rmsFrames[endIdx].timestamp;
        if (end > phraseStart) phrases.push({ start: phraseStart, end, duration: end - phraseStart });
        phraseStart = null;
        silenceRun = 0;
      }
    }
  }
  if (phraseStart !== null) {
    const end = rmsFrames[rmsFrames.length - 1].timestamp;
    if (end > phraseStart) phrases.push({ start: phraseStart, end, duration: end - phraseStart });
  }

  if (!opts) return phrases;
  return subdividePhrases(phrases, rmsFrames, smoothed, hopSec, opts);
}

/**
 * Composite subdivision: within each silence-delimited phrase, split at RMS
 * dips where the weighted evidence exceeds the threshold:
 *
 *   composite = 0.5·rms_drop + 0.3·bow_speed_drop + 0.2·inter_onset_gap
 *
 * A term with no usable data is dropped and the remaining weights are
 * renormalized — the silence-gap phrases are the floor, never made worse.
 */
function subdividePhrases(
  phrases: Phrase[],
  rmsFrames: { value: number; timestamp: number }[],
  smoothed: number[],
  hopSec: number,
  opts: DetectPhrasesOptions,
): Phrase[] {
  // ── Term availability ──
  let speedMedian = 0;
  let bowUsable = false;
  if (opts.bowSpeed && opts.bowSpeed.points.length > 0) {
    const vals = opts.bowSpeed.points.map(p => p.v).filter((v): v is number => v !== null);
    if (vals.length >= 5 && vals.length / opts.bowSpeed.points.length >= PHRASE_BOW_MIN_COVERAGE) {
      speedMedian = median(vals);
      bowUsable = speedMedian > 0;
    }
  }
  const onsets = opts.onsets && opts.onsets.length >= 3
    ? [...opts.onsets].sort((a, b) => a - b)
    : null;
  let medianIOI = 0;
  if (onsets) {
    const iois: number[] = [];
    for (let i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);
    medianIOI = median(iois);
  }
  const gapUsable = onsets !== null && medianIOI > 0;

  let wRms = PHRASE_W_RMS;
  let wBow = bowUsable ? PHRASE_W_BOW : 0;
  let wGap = gapUsable ? PHRASE_W_GAP : 0;
  const wSum = wRms + wBow + wGap;
  wRms /= wSum; wBow /= wSum; wGap /= wSum;

  const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

  const out: Phrase[] = [];
  for (const p of phrases) {
    const startIdx = Math.max(0, Math.round((p.start - rmsFrames[0].timestamp) / hopSec));
    const endIdx = Math.min(rmsFrames.length - 1, Math.round((p.end - rmsFrames[0].timestamp) / hopSec));

    // Reference level for rms_drop: mean of the smoothed envelope in the phrase
    let phraseMean = 0;
    for (let i = startIdx; i <= endIdx; i++) phraseMean += smoothed[i];
    phraseMean /= Math.max(1, endIdx - startIdx + 1);

    let segStart = p.start;
    for (let i = startIdx + 1; i < endIdx; i++) {
      const t = rmsFrames[i].timestamp;
      if (t - segStart < PHRASE_MIN_DURATION_S || p.end - t < PHRASE_MIN_DURATION_S) continue;
      // Boundary candidates are local minima of the smoothed envelope
      if (!(smoothed[i] <= smoothed[i - 1] && smoothed[i] <= smoothed[i + 1])) continue;

      const rmsDrop = phraseMean > 0 ? clamp01((phraseMean - smoothed[i]) / phraseMean) : 0;

      let bowDrop = 0;
      if (bowUsable) {
        const s = opts.bowSpeed!.sample(t, 0.3);
        bowDrop = s !== null ? clamp01((speedMedian - s) / speedMedian) : 0;
      }

      let gapScore = 0;
      if (gapUsable) {
        let prev: number | null = null, next: number | null = null;
        for (const o of onsets!) {
          if (o <= t) prev = o;
          else { next = o; break; }
        }
        if (prev !== null && next !== null) {
          gapScore = clamp01((next - prev - medianIOI) / (2 * medianIOI));
        }
      }

      const composite = wRms * rmsDrop + wBow * bowDrop + wGap * gapScore;
      if (composite >= PHRASE_COMPOSITE_THRESHOLD) {
        out.push({ start: segStart, end: t, duration: t - segStart });
        segStart = t;
      }
    }
    out.push({ start: segStart, end: p.end, duration: p.end - segStart });
  }
  return out;
}

function phraseContext(phrases: Phrase[], t: number): { position: number; duration: number } {
  for (const p of phrases) {
    if (t >= p.start && t <= p.end + 0.1) {
      return {
        position: p.duration > 0 ? Math.min(1, (t - p.start) / p.duration) : 0,
        duration: p.duration,
      };
    }
  }
  return { position: 0, duration: 0 };
}

// ─────────────────────────────────────────────────────────────
// Note segmentation from pitch frames
// ─────────────────────────────────────────────────────────────

interface PitchSegment {
  start: number;
  end: number;
  frames: { frequency: number; timestamp: number }[];
}

// Groups consecutive same-pitch-class pitch frames into note segments.
//
// Gap bridge: up to MAX_NULL_GAP consecutive null frames inside an active note are
// tolerated (handles brief YIN failures on bow attacks or lightly-played frames).
// Beyond that, silence is treated as a note boundary.
//
// The RMS noise gate in detectPitches() (audioEngine.ts) is the primary defence
// against garbage YIN calls on silence — null frames during inter-note silences
// prevent those from opening or extending segments here.
function segmentByPitch(
  pitchFrames: { frequency: number | null; timestamp: number }[],
  duration: number,
): PitchSegment[] {
  const MIN_DURATION_S = 0.05;  // 50ms (was 80ms) — catches fast notes (~32nd at 120 BPM = 62ms)
  const MAX_NULL_GAP   = 4;     // 4×25ms hop = 100ms bridge (was 2×50ms = same tolerance)
  // Must match hopSize in detectPitches (audioEngine.ts). Used to extend the
  // outgoing note's end by one hop past its last detected frame so the handoff
  // between A.endSeconds and B.startSeconds has no audible gap.
  const HOP_S = 0.025;

  const segments: PitchSegment[] = [];
  let curPc: string | null = null;
  let segStart = 0;
  let segFrames: { frequency: number; timestamp: number }[] = [];
  let nullRun = 0;

  const flush = (end: number) => {
    if (curPc === null || segFrames.length === 0) return;
    if (end - segStart >= MIN_DURATION_S) segments.push({ start: segStart, end, frames: segFrames });
    curPc = null;
    segFrames = [];
    nullRun = 0;
  };

  for (const f of pitchFrames) {
    if (f.frequency === null) {
      nullRun++;
      if (curPc !== null && nullRun > MAX_NULL_GAP) {
        const endT = segFrames.length > 0
          ? segFrames[segFrames.length - 1].timestamp + HOP_S
          : f.timestamp;
        flush(endT);
      }
      continue;
    }

    nullRun = 0;
    const midi = Math.round(freqToMidiRaw(f.frequency));
    const pc = NOTE_NAMES[((midi % 12) + 12) % 12];

    if (pc === curPc) {
      segFrames.push({ frequency: f.frequency, timestamp: f.timestamp });
    } else {
      // A ends at the last frame where A was detected + 1 hop (the last moment A
      // was audible). B starts at f.timestamp (the first moment B is audible).
      // These two values are what chip timestamps display and what the overlay
      // uses to decide which note is current — keeping them at actual audible
      // moments guarantees the overlay and chip always agree with the video.
      const aEnd = segFrames.length > 0
        ? segFrames[segFrames.length - 1].timestamp + HOP_S
        : f.timestamp;
      flush(aEnd);
      curPc = pc;
      segStart = f.timestamp;
      segFrames = [{ frequency: f.frequency, timestamp: f.timestamp }];
    }
  }

  if (segFrames.length > 0) flush(duration);
  return segments;
}

// ─────────────────────────────────────────────────────────────
// Hybrid onset: bow-corroborated segment splitting
// ─────────────────────────────────────────────────────────────
//
// segmentByPitch cannot separate repeated same-pitch notes (détaché on one
// note) — the pitch class never changes. The uncollapsed onset list from
// audioEngine retains flux candidates at those boundaries, but flux alone
// over-triggers on bow noise, which is why collapseAdjacentSameNoteOnsets
// removes them for rhythm scoring. Here we re-validate each in-segment
// candidate against the bow signal:
//
//   onset_score = 0.6·flux + 0.4·bow_change_strength
//
// flux is 1 by construction (the candidate exists), so a split requires
// bow_change_strength ≥ 0.5 — a direction flip or a sharp speed change.
// With no bow data the strength is null and we never split (graceful
// degradation to pure pitch segmentation).

const SPLIT_MIN_OFFSET_S = 0.08;  // candidate must be >80ms into the segment
const SPLIT_MIN_TAIL_S   = 0.05;  // and leave ≥ the 50ms min note duration after it
const ONSET_SCORE_FLUX_WEIGHT = 0.6;
const ONSET_SCORE_BOW_WEIGHT  = 0.4;
const ONSET_SPLIT_THRESHOLD   = 0.8;

function medianNonNull(points: Array<TimeSeriesPoint<number | null>>): number | null {
  const vals = points.map(p => p.v).filter((v): v is number => v !== null);
  return vals.length > 0 ? median(vals) : null;
}

/**
 * How strongly the bow signal indicates a stroke change at time t.
 * Returns 0-1, or null when there is no usable bow data around t.
 */
function bowChangeStrength(bow: BowTimeSeries, t: number, speedNorm: number | null): number | null {
  // Direction flip — strongest evidence. Scan a window rather than sampling
  // fixed offsets: the committed direction lags the physical flip by ~3 frames
  // (EMA smoothing + hysteresis), so the window extends further after t.
  const dirWindow = bow.bowDirection.window(t - 0.3, t + 0.45);
  const signs = dirWindow.map(p => p.v).filter((v): v is -1 | 1 => v === 1 || v === -1);
  const sawFlip = signs.some((s, i) => i > 0 && s !== signs[i - 1]);
  if (sawFlip) return 1;

  if (speedNorm === null || speedNorm <= 0) return null;
  const speedBefore = bow.bowSpeed.sample(t - 0.1, 0.15);
  const speedAt     = bow.bowSpeed.sample(t, 0.1);
  const speedAfter  = bow.bowSpeed.sample(t + 0.1, 0.15);
  if (speedBefore === null || speedAfter === null) return null;

  // |Δspeed| across the candidate, plus the dip depth at the reversal itself
  // (speed passes through ~0 at a détaché change even when before ≈ after).
  const delta = Math.abs(speedAfter - speedBefore);
  const dip = speedAt !== null ? Math.max(0, Math.min(speedBefore, speedAfter) - speedAt) : 0;
  return Math.min(1, Math.max(delta, dip) / speedNorm);
}

/**
 * Split pitch segments at bow-corroborated onset candidates.
 * Returns the new segment list plus the start times created by splits —
 * those events are exempt from filterArtifacts (a split same-pitch note is
 * exactly the prev ≈ cur ≈ next pattern the artifact filter targets).
 */
function splitSegmentsAtBowOnsets(
  segments: PitchSegment[],
  candidates: number[],
  bow: BowTimeSeries,
): { segments: PitchSegment[]; splitStarts: Set<number> } {
  const splitStarts = new Set<number>();
  if (candidates.length === 0) return { segments, splitStarts };

  const speedVals = bow.bowSpeed.points.map(p => p.v).filter((v): v is number => v !== null);
  const speedNorm = speedVals.length >= 5 ? median(speedVals) : null;

  const out: PitchSegment[] = [];
  for (const seg of segments) {
    let current = seg;
    for (const t of candidates) {
      if (t <= current.start + SPLIT_MIN_OFFSET_S || t >= seg.end - SPLIT_MIN_TAIL_S) continue;

      const strength = bowChangeStrength(bow, t, speedNorm);
      if (strength === null) continue;
      const score = ONSET_SCORE_FLUX_WEIGHT + ONSET_SCORE_BOW_WEIGHT * strength;
      if (score < ONSET_SPLIT_THRESHOLD) continue;

      const framesA = current.frames.filter(f => f.timestamp < t);
      const framesB = current.frames.filter(f => f.timestamp >= t);
      if (framesA.length === 0 || framesB.length === 0) continue;

      out.push({ start: current.start, end: t, frames: framesA });
      current = { start: t, end: current.end, frames: framesB };
      splitStarts.add(t);
    }
    out.push(current);
  }
  return { segments: out, splitStarts };
}

// Iteratively removes short events that are sandwiched between notes within
// SEMITONE_DIST semitones on both sides AND where those two neighbors are also
// similar to each other — this targets vibrato pitch-class bleed (A→A#→A oscillation)
// and bow-change transients while leaving fast scalar/chromatic passages intact.
//
// The key guard is |prevMidi - nextMidi| <= SEMITONE_DIST: a chromatic passing note
// like G→G#→A has |G-A|=2, so G# is NOT filtered. Only the oscillation pattern
// (prev ≈ cur ≈ next) is removed. MAX_PASSES runs iteratively because filtering one
// artifact can expose the next.
function filterArtifacts(events: NoteEvent[], exemptStarts?: Set<number>): NoteEvent[] {
  const SHORT_S = 0.15;        // candidate threshold: events under 150ms (was 300ms — too aggressive for fast playing)
  const SEMITONE_DIST = 1;     // within 1 semitone of both neighbors
  const MAX_PASSES = 6;

  let arr = events;
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const next = arr.filter((ev, i) => {
      if (ev.durationSeconds >= SHORT_S) return true;
      if (i === 0 || i === arr.length - 1) return true;
      // Bow-corroborated split boundaries are real notes, not oscillation bleed
      if (exemptStarts?.has(ev.startSeconds)) return true;
      const prevMidi = Math.round(freqToMidiRaw(arr[i - 1].pitchHz));
      const curMidi  = Math.round(freqToMidiRaw(ev.pitchHz));
      const nextMidi = Math.round(freqToMidiRaw(arr[i + 1].pitchHz));
      // Only filter if it looks like an oscillation: the two surrounding notes must
      // also be close to each other (not a chromatic/scalar passage moving forward).
      return !(Math.abs(curMidi - prevMidi) <= SEMITONE_DIST &&
               Math.abs(curMidi - nextMidi) <= SEMITONE_DIST &&
               Math.abs(prevMidi - nextMidi) <= SEMITONE_DIST);
    });
    if (next.length === arr.length) break;
    arr = next;
  }
  return arr;
}

// ─────────────────────────────────────────────────────────────
// Main fusion function
// ─────────────────────────────────────────────────────────────

export interface FuseSignalsOptions {
  /** Bow time series from deriveBowTimeSeries — enables hybrid onset splitting
   *  and populates NoteEvent bow fields. Absent = pure audio+pose behavior. */
  bow?: BowTimeSeries;
}

export function fuseSignals(
  audio: RawAudioSignals,
  poseFrames: FrameKeypoints[],
  opts?: FuseSignalsOptions,
): NoteEvent[] {
  const { pitchFrames, rmsFrames, toneFrames, duration } = audio;
  if (pitchFrames.length === 0) return [];

  let segments = segmentByPitch(pitchFrames, duration);
  if (segments.length === 0) return [];

  // Hybrid onset: split same-pitch segments at bow-corroborated boundaries
  const bow = opts?.bow;
  let splitStarts = new Set<number>();
  if (bow && audio.uncollapsedOnsetTimestamps?.length > 0) {
    const split = splitSegmentsAtBowOnsets(segments, audio.uncollapsedOnsetTimestamps, bow);
    segments = split.segments;
    splitStarts = split.splitStarts;
  }

  const maxRms = rmsFrames.reduce((m, f) => Math.max(m, f.value), 0.001);
  const phrases = detectPhrases(rmsFrames, {
    bowSpeed: bow?.bowSpeed,
    onsets: audio.onsetTimestamps,
  });
  const events: NoteEvent[] = [];

  for (const seg of segments) {
    const { start: noteStart, end: noteEnd, frames: segPitches } = seg;
    const noteDuration = noteEnd - noteStart;

    const pitchHz = median(segPitches.map(f => f.frequency));
    if (pitchHz < 150 || pitchHz > 5000) continue;

    // Pitch identity
    const midiRaw = freqToMidiRaw(pitchHz);
    const midiRounded = Math.round(midiRaw);
    const centsDeviation = (midiRaw - midiRounded) * 100;
    const noteName = midiToName(midiRounded);
    const str = inferString(pitchHz);
    const finger = inferFinger(pitchHz, str);
    const posGrp = positionGroupFromMidi(midiRounded);

    // Tone quality: mean fundamental ratio in window
    const noteTones = toneFrames.filter(f => f.timestamp >= noteStart && f.timestamp < noteEnd);
    const fundamentalRatio = noteTones.length > 0
      ? noteTones.reduce((s, f) => s + f.fundamentalRatio, 0) / noteTones.length
      : 0.5;

    // Dynamic level: mean RMS in window, normalized to session max
    const noteRmsVals = rmsFrames.filter(f => f.timestamp >= noteStart && f.timestamp < noteEnd);
    const meanRms = noteRmsVals.length > 0
      ? noteRmsVals.reduce((s, f) => s + f.value, 0) / noteRmsVals.length
      : 0;
    const dynamicLevel = Math.min(1, meanRms / maxRms);

    // Pose signals at note midpoint
    const noteMid = (noteStart + noteEnd) / 2;
    const poseFrame = nearestPoseFrame(poseFrames, noteMid);
    const wristCollapsed  = poseFrame ? getWristCollapsed(poseFrame)  : null;
    const shoulderRaised  = poseFrame ? getShoulderRaised(poseFrame)  : null;
    const bowZone         = poseFrame ? getBowZone(poseFrame)         : null;

    // Bow signals: median over the note window (null when detector saw nothing)
    const bowContactPoint = bow ? medianNonNull(bow.bowContactPoint.window(noteStart, noteEnd)) : null;
    const bowAngle        = bow ? medianNonNull(bow.bowAngle.window(noteStart, noteEnd))        : null;

    // Phrase context
    const { position: phrasePosition, duration: phraseDurationSeconds } =
      phraseContext(phrases, noteStart);

    events.push({
      startSeconds: noteStart,
      endSeconds: noteEnd,
      durationSeconds: noteDuration,
      pitchHz,
      noteName,
      string: str,
      inferredFinger: finger,
      positionGroup: posGrp,
      centsDeviation,
      absCentsDeviation: Math.abs(centsDeviation),
      inTune: Math.abs(centsDeviation) <= 25,
      fundamentalRatio,
      dynamicLevel,
      bowContactPoint,
      bowAngle,
      bowDistanceFromBridge: null,  // needs bridge detector (Phase 18)
      bowZone,
      wristCollapsed,
      shoulderRaised,
      distanceFromCrossing: null,  // filled in below
      phrasePosition,
      phraseDurationSeconds,
    });
  }

  // Remove vibrato bleed and bow-change transients before final output
  const filtered = filterArtifacts(events, splitStarts);

  // distanceFromCrossing — scan back up to 5 notes for last string change
  for (let i = 0; i < filtered.length; i++) {
    let dist: number | null = null;
    for (let j = i - 1; j >= Math.max(0, i - 5); j--) {
      if (filtered[j].string !== filtered[i].string) {
        dist = i - j;
        break;
      }
    }
    filtered[i].distanceFromCrossing = dist;
  }

  return filtered;
}

// ─────────────────────────────────────────────────────────────
// Debug logger — call inside __DEV__ guard
// ─────────────────────────────────────────────────────────────

export function debugLogNoteEvents(noteEvents: NoteEvent[]): void {
  if (noteEvents.length === 0) {
    console.log('[NoteFusion] No note events detected (no pitched audio found in recording)');
    return;
  }

  const header = [
    'time'.padEnd(14),
    'note'.padEnd(5),
    'cents'.padStart(6),
    '  str',
    'fgr',
    ' vol',
    'ratio',
    'tune',
    'wrist',
    'xing',
    'phrase',
  ].join(' ');
  const sep = '─'.repeat(header.length);

  console.log(`\n[NoteFusion] ── ${noteEvents.length} note events ─────────────────────────────────`);
  console.log('  ' + header);
  console.log('  ' + sep);

  for (const n of noteEvents) {
    const time  = `${n.startSeconds.toFixed(2)}-${n.endSeconds.toFixed(2)}s`.padEnd(14);
    const note  = n.noteName.padEnd(5);
    const cents = ((n.centsDeviation >= 0 ? '+' : '') + Math.round(n.centsDeviation) + 'c').padStart(6);
    const str   = '  ' + n.string;
    const fgr   = ' ' + n.inferredFinger;
    const vol   = n.dynamicLevel.toFixed(2).padStart(4);
    const ratio = n.fundamentalRatio.toFixed(2).padStart(5);
    const tune  = n.inTune ? ' yes' : '  no';
    const wrist = n.wristCollapsed === null ? '   --' : n.wristCollapsed ? '  BAD' : '   ok';
    const xing  = n.distanceFromCrossing === null ? '  --' : ('  ' + n.distanceFromCrossing);
    const phrase = n.phrasePosition.toFixed(2).padStart(6);
    console.log('  ' + [time, note, cents, str, fgr, vol, ratio, tune, wrist, xing, phrase].join(' '));
  }

  // Summary
  const total = noteEvents.length;
  const inTuneN  = noteEvents.filter(n => n.inTune).length;
  const pct      = Math.round((inTuneN / total) * 100);
  const sCounts  = { G: 0, D: 0, A: 0, E: 0 } as Record<string, number>;
  const fCounts  = [0, 0, 0, 0, 0];
  for (const n of noteEvents) { sCounts[n.string]++; fCounts[n.inferredFinger]++; }

  // Crossing intonation check
  const afterCrossing = noteEvents.filter(n => n.distanceFromCrossing !== null && n.distanceFromCrossing <= 1);
  const xingInTune    = afterCrossing.filter(n => n.inTune).length;

  // Per-finger in-tune rate
  const fingerStats = fCounts.map((total, fi) => {
    if (total === 0) return null;
    const good = noteEvents.filter(n => n.inferredFinger === fi && n.inTune).length;
    return { fi, total, pct: Math.round((good / total) * 100) };
  }).filter(Boolean) as { fi: number; total: number; pct: number }[];

  console.log('  ' + sep);
  console.log(`  In tune: ${inTuneN}/${total} (${pct}%)`);
  console.log(`  Strings: G:${sCounts.G}  D:${sCounts.D}  A:${sCounts.A}  E:${sCounts.E}`);
  console.log(`  Fingers: open:${fCounts[0]}  1st:${fCounts[1]}  2nd:${fCounts[2]}  3rd:${fCounts[3]}  4th:${fCounts[4]}`);
  console.log(`  Per-finger tune%: ${fingerStats.map(s => `${s!.fi === 0 ? 'open' : s!.fi + 'st'}:${s!.pct}%`).join('  ')}`);
  if (afterCrossing.length > 0) {
    console.log(`  After string crossings: ${xingInTune}/${afterCrossing.length} in tune (${Math.round((xingInTune / afterCrossing.length) * 100)}%)`);
  }
  const wristBad = noteEvents.filter(n => n.wristCollapsed === true).length;
  if (wristBad > 0) {
    console.log(`  Wrist collapsed: ${wristBad} notes (${Math.round((wristBad / total) * 100)}%)`);
  }
  console.log('[NoteFusion] ─────────────────────────────────────────────────────────────────\n');
}

// ─────────────────────────────────────────────────────────────
// Derive IntonationAnalysis from NoteEvent[] (single source of truth)
// ─────────────────────────────────────────────────────────────

export function deriveIntonationAnalysis(noteEvents: NoteEvent[]): IntonationAnalysis {
  if (noteEvents.length === 0) {
    return {
      totalNoteEvents: 0,
      inTuneCount: 0,
      outOfTuneCount: 0,
      inTuneRate: 1,
      overallTendency: 'neutral',
      tendencyCents: 0,
      problemNotes: [],
      observationSummary: 'No notes detected — check audio recording.',
      _score: 50,
    };
  }

  const inTuneCount = noteEvents.filter(n => n.inTune).length;
  const outOfTuneCount = noteEvents.length - inTuneCount;
  const inTuneRate = inTuneCount / noteEvents.length;
  const meanCents = noteEvents.reduce((s, n) => s + n.centsDeviation, 0) / noteEvents.length;
  const overallTendency: IntonationAnalysis['overallTendency'] =
    meanCents < -8 ? 'flat' : meanCents > 8 ? 'sharp' : 'neutral';

  // Group by full note name including octave (e.g. "B4", "B5" are separate entries)
  const byClass = new Map<string, { all: NoteEvent[]; outOfTune: NoteEvent[] }>();
  for (const n of noteEvents) {
    const pc = n.noteName;
    if (!byClass.has(pc)) byClass.set(pc, { all: [], outOfTune: [] });
    const entry = byClass.get(pc)!;
    entry.all.push(n);
    if (!n.inTune) entry.outOfTune.push(n);
  }

  const problemNotes: PitchClassIssue[] = [];
  for (const [pc, { all: pcNotes, outOfTune: badNotes }] of byClass.entries()) {
    const outCnt = badNotes.length;
    const rate = outCnt / pcNotes.length;
    // Minimum bar: ≥2 out-of-tune occurrences OR error rate ≥ 30%
    if (outCnt < 2 && rate < 0.30) continue;

    const avgDev = badNotes.reduce((s, n) => s + n.centsDeviation, 0) / outCnt;

    // Deduplicate timestamps (keep first 3, skip those within 2s of a kept one)
    const deduped: { startSeconds: number; endSeconds: number }[] = [];
    for (const n of badNotes) {
      if (!deduped.some(k => Math.abs(k.startSeconds - n.startSeconds) < 2.0)) {
        deduped.push({ startSeconds: n.startSeconds, endSeconds: n.endSeconds });
      }
    }

    // Most common MIDI pitch for this class (includes octave context)
    const midiCounts = new Map<number, number>();
    for (const n of pcNotes) {
      const midi = Math.round(freqToMidiRaw(n.pitchHz));
      midiCounts.set(midi, (midiCounts.get(midi) ?? 0) + 1);
    }
    const representativeMidi = [...midiCounts.entries()]
      .sort((a, b) => b[1] - a[1])[0]?.[0];

    problemNotes.push({
      pitchClass: pc,
      totalNoteEvents: pcNotes.length,
      outOfTuneCount: outCnt,
      errorRate: rate,
      avgDeviationCents: Math.round(avgDev),
      tendency: avgDev < -5 ? 'flat' : avgDev > 5 ? 'sharp' : 'mixed',
      exampleTimestamps: deduped.slice(0, 3),
      representativeMidi,
    });
  }

  problemNotes.sort((a, b) => b.outOfTuneCount - a.outOfTuneCount);

  // Observation summary — same format as intonationAnalysis.ts
  let observationSummary: string;
  if (outOfTuneCount === 0) {
    observationSummary = 'All detected notes were in tune.';
  } else {
    const inTunePct = Math.round((inTuneCount / noteEvents.length) * 100);
    if (problemNotes.length === 0) {
      observationSummary = `${outOfTuneCount} note${outOfTuneCount !== 1 ? 's were' : ' was'} out of tune.`;
    } else {
      const top = problemNotes[0];
      const tend = top.tendency === 'flat' ? 'flat' : top.tendency === 'sharp' ? 'sharp' : 'off';
      observationSummary =
        `${top.pitchClass} was ${tend} ${top.outOfTuneCount}× ` +
        `(${Math.round(top.errorRate * 100)}% of the time). ` +
        `${inTunePct}% of notes in tune overall.`;
    }
  }

  return {
    totalNoteEvents: noteEvents.length,
    inTuneCount,
    outOfTuneCount,
    inTuneRate,
    overallTendency,
    tendencyCents: Math.round(meanCents),
    problemNotes,
    observationSummary,
    _score: Math.round(inTuneRate * 100),
  };
}
