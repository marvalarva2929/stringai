/**
 * Tone-quality analysis for bowed strings.
 *
 * Replaces the old single-feature HNR detector with a multi-feature acoustic
 * model grounded in how a violin tone is produced (Schelleng's force / speed /
 * contact-point space). See plans/i-want-piped-emerson.md for the full design.
 *
 * Pipeline:
 *   1. extractToneFrameFeatures() — per 50 ms frame, compute a feature vector
 *      (periodicity, HNR, inter-harmonic noise floor, subharmonic ratio,
 *      fundamental ratio, centroid, rolloff, spectral flatness, loudness).
 *   2. scoreFrame() — collapse the vector into a 0–100 tone score + a dominant
 *      fault label per frame.
 *   3. Per-note trajectory — segment frames into notes and detect temporal
 *      faults (onset clears up, mid-note decay, flicker, delayed speech).
 *   4. Session aggregation — a mean / low-percentile blend (so uneven playing
 *      can't be rescued by clean frames) minus a flicker penalty, plus
 *      flagged regions and a symptom-first-then-cause observation.
 *
 * This module has NO Expo / React Native imports, so it runs under plain Node
 * for unit testing (see test/toneAnalysis.test.ts).
 */

import { severityFromScore } from '../types/analysis';
import type {
  MetricScore,
  TechniqueEvent,
  FlaggedTimestamp,
  ToneFault,
} from '../types/analysis';
import {
  clamp,
  magnitudeSpectrum,
  estimateF0HPS,
  sumHarmonicPower,
} from './dsp';
import type { PitchFrame } from './dsp';

// ─────────────────────────────────────────────────────────────
// Tunable constants (calibration targets — see §7 of the plan)
// ─────────────────────────────────────────────────────────────

const FFT_SIZE        = 2048;
const HOP_S           = 0.05;          // 50 ms frame hop
const SILENCE_MAX_MAG = 0.002;         // peak magnitude below this → frame is silence
const N_HARMONICS     = 12;            // partials summed for harmonic power
const HARM_BW_BINS    = 2;             // ±bins around each harmonic / trough center
const BRIGHT_CUTOFF_HZ = 3500;         // energy above this = "high frequency" (rolloff)
const SF_LO_HZ        = 400;           // spectral-flatness band
const SF_HI_HZ        = 4000;

// Cleanliness mapping. CALIBRATED against real phone recordings in test/fixtures/tone
// (2026-06): on real audio, spectral flatness (SF) is the dominant tone discriminator —
// harmonic-to-noise ratio, inter-harmonic noise floor and periodicity stay near-clean
// even for a scratchy bow, so SF carries the score. SF rises with broadband bow noise.
const SF_GOOD = 0.40;  // spectral flatness at/below this → clean (score 100)
const SF_BAD  = 0.66;  // spectral flatness at/above this → noise-like (score 0)

// Periodicity is a weak corroborating signal on real audio (usually high even when
// noisy) — used only to nudge the score down when confidently low.
const P_SCRATCH = 0.65;   // periodicity below this → clearly aperiodic
const P_ROUGH   = 0.85;   // periodicity below this → mild roughness
const P_PEN_MAX = 25;     // max periodicity penalty

// Subharmonic / period-doubling (over-pressure crunch).
const SUB_BAD     = 0.12;
const SUB_PEN_MAX = 40;

// Median spectral-flatness thresholds for per-note / clip diagnosis (real-audio calibrated).
const SF_MED_SCRATCH = 0.46;  // median SF above this → pervasively scratchy
const SF_MED_RASP    = 0.44;  // median SF above this → raspy overall

// Contact-point shaping (centroid expressed as a multiple of f0 = "harmonic number")
const CN_PONT     = 8;      // centroid/f0 above this → sul ponticello (glassy). Clean ≈ 4–6.
const CN_PONT_CAP = 14;     // centroid/f0 at which the ponticello penalty maxes out
const F1_HOLLOW   = 0.12;   // fundamental/harmonic below this → hollow (supports ponticello)
const CONTACT_PEN_MAX = 22; // max penalty from a sul-ponticello fault

// Thin / hollow tone. CALIBRATED (2026-06) from real clips: a thin tone collapses its
// energy onto the fundamental with the upper harmonics missing — measured by F1
// (fundamental power / harmonic power). Real data: good tone F1 ≈ 0.18–0.52, thin tone
// ≈ 0.82–0.98. A flat threshold (no string/register inference — pitch alone can't tell
// which string is bowed) cleanly separates them; genuinely-acceptable thin tone (e.g. a
// light E string) naturally sits at low F1 and falls below the threshold anyway.
const F1_THIN      = 0.60;   // fundamental dominance above this → thin (hollow form)
const F1_THIN_FULL = 0.85;   // F1 at which the hollow-thin penalty maxes out
// Surface / airy thin (under-pressure or low rosin): the fundamental COLLAPSES and the
// note rides on surface noise. Over-pressure scratch instead keeps the low harmonics
// strong (F1 stays moderate ≈0.14+), so F1 separates "needs more pressure" (airy) from
// "needs less pressure" (scratch) even at equal loudness. Real data: airy F1≈0.01,
// scratch F1≈0.14–0.17, good F1≈0.18–0.52.
const F1_SURFACE   = 0.10;   // fundamental below this (with noise) → surface/airy thin
const THIN_PEN_MAX = 45;     // max penalty for a thin/hollow tone
// Clip-level airy penalty: per-frame F1 is too noisy (even clean takes have many weak-
// fundamental frames), but a clip whose MEDIAN fundamental is collapsed is pervasively
// thin/airy (e.g. low rosin — bow won't grip). Real medians: good ≥ 0.18, airy ≤ 0.12.
const F1_AIRY_HI    = 0.18;  // clip median F1 below this → pervasively airy (ramp start = clean floor)
const AIRY_PEN_MAX  = 55;    // max clip-level airy penalty
const AIRY_MIN_RELF = 0.4;   // need this fraction of pitch-locked frames to trust median F1

// Flagging & aggregation
// Session blend favours the MEDIAN frame score: real "good" playing contains noisy
// transients (bow changes, fast notes) that a low-percentile would over-punish,
// whereas a genuinely scratchy clip is pervasively noisy so its median is low too.
const W_MEDIAN = 0.75, W_MEAN = 0.25;
const BAD_FRAME = 55;       // a frame this low is "actually bad" (guards temporal faults)
const FLICKER_BAD = 38;     // within-note score std (points) for full flicker penalty (real playing varies)
const FLICKER_PEN_MAX = 10; // resurrected HNR_STAB_PEN_MAX — penalize uneven bowing

// Per-note trajectory. Thresholds kept high so normal expressive playing doesn't trip them.
const MIN_NOTE_FRAMES = 5;          // ≥250 ms to assess a note
const ATTACK_S        = 0.12;       // first 120 ms = attack transient
const ATTACK_DELTA    = 35;         // sustain − attack score gap that flags an onset issue
const DECAY_DELTA     = 35;         // first-half − second-half gap that flags decay

// ─────────────────────────────────────────────────────────────
// Per-frame feature vector
// ─────────────────────────────────────────────────────────────

export interface ToneFrameFeatures {
  t: number;            // start time (seconds)
  voiced: boolean;      // false for silence frames (no spectral energy)
  pitchReliable: boolean; // YIN locked a pitch this frame (f0 trustworthy)
  f0: number;           // fundamental (Hz) used for harmonic analysis, 0 if none
  P: number;            // periodicity 0..1 (from YIN)
  HNR: number;      // harmonic power / total power
  NF: number;       // inter-harmonic noise floor ratio 0..1
  SUB: number;      // subharmonic (f0/2) power / harmonic power
  F1: number;       // fundamental power / harmonic power
  C: number;        // spectral centroid (Hz)
  CN: number;       // centroid / f0 (harmonic number), 0 if no f0
  RO: number;       // high-frequency energy fraction
  SF: number;       // spectral flatness 0..1 (mid band)
  L: number;        // frame RMS loudness
  score: number;    // per-frame tone score 0..100 (filled by scoreFrame)
}

/** Nearest-neighbour lookup of YIN periodicity/frequency for a given time. */
function makePitchSampler(pitches: PitchFrame[]) {
  let ptr = 0;
  return (t: number): { periodicity: number; frequency: number | null; locked?: boolean } => {
    if (pitches.length === 0) return { periodicity: 0, frequency: null, locked: false };
    while (ptr + 1 < pitches.length && pitches[ptr + 1].timestamp <= t) ptr++;
    // pick whichever of ptr / ptr+1 is closer in time
    let best = pitches[ptr];
    if (ptr + 1 < pitches.length &&
        Math.abs(pitches[ptr + 1].timestamp - t) < Math.abs(best.timestamp - t)) {
      best = pitches[ptr + 1];
    }
    return { periodicity: best.periodicity ?? 0, frequency: best.frequency, locked: best.locked };
  };
}

/**
 * Extract the per-frame tone feature vector across the whole clip.
 * `pitches` supplies YIN periodicity (the cheapest, strongest scratch detector).
 */
export function extractToneFrameFeatures(
  samples: Float32Array,
  sampleRate: number,
  pitches: PitchFrame[],
): ToneFrameFeatures[] {
  const hopSize = Math.round(sampleRate * HOP_S);
  const binHz = sampleRate / FFT_SIZE;
  const brightBin = Math.floor(BRIGHT_CUTOFF_HZ / binHz);
  const sfLoBin = Math.max(1, Math.floor(SF_LO_HZ / binHz));
  const sfHiBin = Math.floor(SF_HI_HZ / binHz);
  const samplePitch = makePitchSampler(pitches);

  const out: ToneFrameFeatures[] = [];
  let lastGoodF0 = 0; // carried forward so noisy frames are analyzed at the expected pitch

  for (let offset = 0; offset + FFT_SIZE < samples.length; offset += hopSize) {
    const t = offset / sampleRate;
    const mag = magnitudeSpectrum(samples, offset, FFT_SIZE);

    // Single pass: total power, centroid numerator, high-freq power, peak, frame RMS
    let maxMag = 0, totalPow = 0, weightedSum = 0, highPow = 0, sq = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      weightedSum += i * binHz * m2;
      if (i >= brightBin) highPow += m2;
      if (mag[i] > maxMag) maxMag = mag[i];
    }
    for (let j = 0; j < FFT_SIZE && offset + j < samples.length; j++) sq += samples[offset + j] ** 2;
    const L = Math.sqrt(sq / FFT_SIZE);

    const { periodicity, frequency: sampledF0, locked } = samplePitch(t);
    // Tone analysis needs "is this frame periodic?", not "what is the best pitch
    // guess?". detectPitches now reports a pitch even when YIN found no dip below
    // its absolute threshold (a global-minimum fallback, so the practice grader
    // stops discarding real playing) — but on a genuinely noisy frame that
    // fallback is an arbitrary lag. Treating it as a locked pitch would put a
    // garbage f0 in place of the carried-forward one below, moving the harmonic
    // and trough bins off the real partials and reading the noise floor as zero.
    const yinF0 = locked === false ? null : sampledF0;

    if (maxMag < SILENCE_MAX_MAG) {
      out.push(emptyFrame(t, L));
      continue;
    }

    const centroid = totalPow > 1e-10 ? weightedSum / totalPow : 0;

    // Fundamental. YIN is sub-bin accurate when it locks a pitch; HPS is bin-
    // quantized and unreliable on rough signals. When YIN can't lock (noisy frame)
    // we carry the previous good pitch forward so the frame is still analyzed at the
    // expected fundamental — revealing its raised noise floor rather than chasing a
    // garbage HPS estimate.
    const pitchReliable = yinF0 !== null;
    let f0 = 0;
    if (yinF0 !== null) { f0 = yinF0; lastGoodF0 = yinF0; }
    else if (lastGoodF0 > 0) f0 = lastGoodF0;
    else f0 = estimateF0HPS(mag, sampleRate, FFT_SIZE) ?? 0;

    let HNR = 0, NF = 1, SUB = 0, F1 = 0, CN = 0;
    if (f0 > 0) {
      const { harmonicPow } = sumHarmonicPower(mag, f0, sampleRate, FFT_SIZE, N_HARMONICS, HARM_BW_BINS);
      HNR = harmonicPow / (totalPow + 1e-10);

      // Inter-harmonic noise floor: power in the troughs midway between partials.
      let troughPow = 0;
      for (let k = 1; k < N_HARMONICS; k++) {
        troughPow += bandPower(mag, ((k + 0.5) * f0) / binHz, HARM_BW_BINS);
      }
      NF = troughPow / (troughPow + harmonicPow + 1e-10);

      // Subharmonic (octave-down) energy — the signature of period-doubling.
      SUB = bandPower(mag, (f0 * 0.5) / binHz, HARM_BW_BINS) / (harmonicPow + 1e-10);

      // Fundamental strength vs the full harmonic series (ponticello vs tasto).
      F1 = bandPower(mag, f0 / binHz, HARM_BW_BINS) / (harmonicPow + 1e-10);

      CN = centroid / f0;
    }

    out.push({
      t,
      voiced: true,
      pitchReliable,
      f0,
      P: periodicity,
      HNR,
      NF,
      SUB,
      F1,
      C: centroid,
      CN,
      RO: totalPow > 1e-10 ? highPow / totalPow : 0,
      SF: spectralFlatness(mag, sfLoBin, sfHiBin),
      L,
      score: 0,
    });
  }

  for (const f of out) if (f.voiced) scoreFrame(f);

  return out;
}

function emptyFrame(t: number, L: number): ToneFrameFeatures {
  return { t, voiced: false, pitchReliable: false, f0: 0, P: 0, HNR: 0, NF: 1, SUB: 0, F1: 0, C: 0, CN: 0, RO: 0, SF: 1, L, score: 0 };
}

/** Power summed over ±bw bins around a (possibly fractional) center bin. */
function bandPower(mag: Float32Array, centerBin: number, bw: number): number {
  const c = Math.round(centerBin);
  if (c < 0 || c >= mag.length) return 0;
  let p = 0;
  for (let b = Math.max(0, c - bw); b <= Math.min(mag.length - 1, c + bw); b++) p += mag[b] * mag[b];
  return p;
}

/** Spectral flatness (geometric mean / arithmetic mean of magnitude) over a band. */
function spectralFlatness(mag: Float32Array, lo: number, hi: number): number {
  const top = Math.min(hi, mag.length - 1);
  if (top <= lo) return 1;
  let logSum = 0, arith = 0, n = 0;
  for (let i = lo; i <= top; i++) {
    const m = mag[i] + 1e-9;
    logSum += Math.log(m);
    arith += m;
    n++;
  }
  if (n === 0 || arith <= 0) return 1;
  const geo = Math.exp(logSum / n);
  return clamp(geo / (arith / n), 0, 1);
}

// ─────────────────────────────────────────────────────────────
// Per-frame scoring + fault classification
// ─────────────────────────────────────────────────────────────

function scoreFrame(f: ToneFrameFeatures): void {
  // Periodicity is only meaningful when YIN actually ran (loud enough not to be
  // RMS-gated). A gated frame reports P=0 — treat that as "unknown", not scratch.
  const pKnown = f.P > 0.01;

  // Cleanliness is driven by spectral flatness (the real-audio discriminator).
  let s = clamp(((SF_BAD - f.SF) / (SF_BAD - SF_GOOD)) * 100);

  // Periodicity only nudges the score down when confidently low (corroborating).
  if (pKnown && f.P < P_ROUGH) {
    s -= clamp(((P_ROUGH - f.P) / (P_ROUGH - P_SCRATCH)) * P_PEN_MAX, 0, P_PEN_MAX);
  }

  // Period-doubling (raucous over-pressure) — needs a reliable f0.
  if (f.pitchReliable) s -= clamp((f.SUB / SUB_BAD) * SUB_PEN_MAX, 0, SUB_PEN_MAX);

  // Sul ponticello (glassy, near the bridge): very bright with a weak fundamental.
  // Conservative and only on a reliable pitch. NOTE: on phone recordings the glassy
  // high harmonics are largely rolled off, so this rarely fires on real clips — the
  // dull / sul-tasto end is handled by the F1 thin detector below.
  const ponticello = f.pitchReliable && f.CN > CN_PONT && f.F1 < F1_HOLLOW;
  if (ponticello) {
    s -= clamp(((f.CN - CN_PONT) / (CN_PONT_CAP - CN_PONT)) * CONTACT_PEN_MAX, 0, CONTACT_PEN_MAX);
  }

  // Hollow thin (fundamental dominates, overtones missing) is the only thin form that
  // needs an extra score penalty; surface/airy thin is already captured by its high SF
  // above. The per-note fault LABEL is decided later by classifyFrames() on medians.
  const hollowThin = f.pitchReliable && f.F1 > F1_THIN;
  if (hollowThin) s -= clamp(((f.F1 - F1_THIN) / (F1_THIN_FULL - F1_THIN)) * THIN_PEN_MAX, 0, THIN_PEN_MAX);

  f.score = clamp(Math.round(s));
}

// ─────────────────────────────────────────────────────────────
// Per-note segmentation + temporal trajectory
// ─────────────────────────────────────────────────────────────

interface ToneNote {
  startS: number;
  endS: number;
  frames: ToneFrameFeatures[];
  score: number;                              // median frame score for this note
  fault: Exclude<ToneFault, 'clean'> | null;  // sustained fault for this note (null = ok)
  flickerPenalty: number;     // 0..FLICKER_PEN_MAX
  temporalFault: ToneFault | null;
}

/** A contiguous run of same-fault notes — one "this stretch needs work" span. */
interface ToneSection {
  startSeconds: number;
  endSeconds: number;
  fault: Exclude<ToneFault, 'clean'>;
  scoreSum: number;   // sum of member-note scores (÷ noteCount = avg)
  noteCount: number;
}

/**
 * Group frames into notes. A note is bounded by silence or a large pitch jump
 * between *reliably-pitched* frames. Noisy (unreliable-pitch) frames do NOT break
 * the note — they attach to it, so a scratchy onset/decay stays part of its note.
 */
function segmentNotes(frames: ToneFrameFeatures[]): ToneNote[] {
  const notes: ToneNote[] = [];
  let cur: ToneFrameFeatures[] = [];
  let lastReliableF0 = 0;

  const flush = () => {
    if (cur.length >= MIN_NOTE_FRAMES) notes.push(analyzeNote(cur));
    cur = [];
    lastReliableF0 = 0;
  };

  for (const f of frames) {
    if (!f.voiced) { flush(); continue; } // true silence ends the note
    if (f.pitchReliable && lastReliableF0 > 0) {
      const jump = Math.abs(1200 * Math.log2(f.f0 / lastReliableF0)); // cents
      if (jump > 80) flush();
    }
    cur.push(f);
    if (f.pitchReliable) lastReliableF0 = f.f0;
  }
  flush();
  return notes;
}

function analyzeNote(frames: ToneFrameFeatures[]): ToneNote {
  const startS = frames[0].t;
  const endS = frames[frames.length - 1].t + HOP_S;

  const attack = frames.filter((f) => f.t - startS < ATTACK_S);
  const sustain = frames.filter((f) => f.t - startS >= ATTACK_S);
  const body = sustain.length >= 2 ? sustain : frames;

  // Flicker: within-note score variability (uneven bow pressure).
  const flickerStd = std(body.map((f) => f.score));
  const flickerPenalty = clamp((flickerStd / FLICKER_BAD) * FLICKER_PEN_MAX, 0, FLICKER_PEN_MAX);

  let temporalFault: ToneFault | null = null;

  // Onset issues: attack noticeably worse than the settled tone. A loud, noisy
  // attack = bite/scratch; a quiet, airy attack = the string speaking late.
  if (attack.length >= 1 && sustain.length >= 2) {
    const aMean = mean(attack.map((f) => f.score));
    const sMean = mean(sustain.map((f) => f.score));
    // Require the attack to be ABSOLUTELY bad, not just relatively lower than a
    // great sustain — otherwise normal note onsets trip this on good playing.
    if (sMean - aMean > ATTACK_DELTA && aMean < BAD_FRAME) {
      const attackQuiet = mean(attack.map((f) => f.L)) < 0.55 * mean(sustain.map((f) => f.L));
      temporalFault = attackQuiet ? 'delayed_speech' : 'onset_scratch';
    }
  }

  // Decay: tone degrades toward the end — caught by either a sustained negative
  // trend (slope) or a clear first-half / second-half drop, and the end must be
  // absolutely bad.
  if (!temporalFault && frames.length >= 6) {
    const dropPerNote = -trendSlope(frames.map((f) => f.score)) * frames.length;
    const half = Math.floor(frames.length / 2);
    const firstMean = mean(frames.slice(0, half).map((f) => f.score));
    const lastMean = mean(frames.slice(half).map((f) => f.score));
    if ((dropPerNote > DECAY_DELTA || firstMean - lastMean > DECAY_DELTA) && lastMean < BAD_FRAME) {
      temporalFault = 'decay';
    }
  }

  // Flicker: high within-note variability without a clean directional trend.
  if (!temporalFault && flickerPenalty >= FLICKER_PEN_MAX * 0.6) temporalFault = 'flicker';

  const score = percentile(frames.map((f) => f.score), 0.5);
  const fault = classifyFrames(frames);

  return { startS, endS, frames, score, fault, flickerPenalty, temporalFault };
}

/**
 * Classify a set of frames into a single sustained tone fault (or null) from their
 * feature MEDIANS — stable, unlike tallying per-frame labels. Used both per-note
 * (for sectioning) and clip-wide (for the headline). Thin (hollow OR collapsed
 * fundamental) is checked before the noise labels since high/low F1 is physically
 * distinct from broadband over-pressure scratch.
 */
/**
 * Classifies a window of frames as a sustained fault (scratch/rasp/thin) or
 * clean. Note: this covers only the pressure/contact faults classifyFrames can
 * actually decide from spectral-flatness/F1 medians. ponticello/tasto/whistle
 * and the temporal faults (onset_scratch/delayed_speech/decay/flicker) come
 * from the separate per-note trajectory analysis below, not from this function.
 */
export function classifyFrames(frames: ToneFrameFeatures[]): Exclude<ToneFault, 'clean'> | null {
  const voiced = frames.filter((f) => f.voiced);
  if (voiced.length === 0) return null;
  const rel = voiced.filter((f) => f.pitchReliable);
  const medSF = percentile(voiced.map((f) => f.SF), 0.5);
  const medF1 = rel.length ? percentile(rel.map((f) => f.F1), 0.5) : 0.5;

  if (rel.length) {
    if (medF1 > F1_THIN) return 'thin';                       // hollow (overtones missing)
    if (medF1 < F1_SURFACE && medSF > SF_MED_RASP) return 'thin'; // surface/airy (collapsed fundamental + noise)
  }
  if (medSF > SF_MED_SCRATCH) return 'scratch';
  if (medSF > SF_MED_RASP) return 'rasp';
  return null;
}

/**
 * Group notes into contiguous SECTIONS that need work. A section is a run of notes that
 * actually score poorly (note.score < SECTION_BAD) — not merely notes that cross a
 * feature threshold — so good takes don't fragment into spurious spans. Adjacent problem
 * notes merge across short gaps (and the odd acceptable note between them); each section's
 * fault is classified over ALL its frames (a more reliable estimate than any single note).
 */
function buildSections(notes: ToneNote[]): ToneSection[] {
  const SECTION_BAD = 62;       // a note must score below this to count as a problem
  const SECTION_BRIDGE_S = 1.5; // bridge SAME-fault problem notes separated by less than this
  const MIN_SECTION_S = 0.4;    // drop blips shorter than this

  // Group consecutive problem notes that share the SAME fault (combine "similar" notes).
  // A different fault, or a gap longer than the bridge, starts a new section — so a thin
  // stretch followed by a scratchy stretch stays two distinct sections.
  const runs: ToneNote[][] = [];
  let cur: ToneNote[] = [];
  for (const n of notes) {
    if (n.fault === null || n.score >= SECTION_BAD) continue; // not a problem note
    const prev = cur[cur.length - 1];
    if (prev && prev.fault === n.fault && n.startS - prev.endS <= SECTION_BRIDGE_S) {
      cur.push(n);
    } else {
      if (cur.length > 0) runs.push(cur);
      cur = [n];
    }
  }
  if (cur.length > 0) runs.push(cur);

  const sections: ToneSection[] = [];
  for (const run of runs) {
    const startSeconds = run[0].startS;
    const endSeconds = run[run.length - 1].endS;
    if (endSeconds - startSeconds < MIN_SECTION_S) continue;
    sections.push({
      startSeconds,
      endSeconds,
      fault: run[0].fault!,  // homogeneous by construction
      scoreSum: run.reduce((a, n) => a + n.score, 0),
      noteCount: run.length,
    });
  }
  return sections;
}

// ─────────────────────────────────────────────────────────────
// Session scoring + observation text
// ─────────────────────────────────────────────────────────────

export const FAULT_MESSAGE: Record<Exclude<ToneFault, 'clean'>, { symptom: string; cause: string }> = {
  scratch:        { symptom: 'The tone was scratchy and rough', cause: 'often caused by too much bow pressure for the bow speed — try easing the weight or using more bow' },
  rasp:           { symptom: 'The tone was grainy / slightly noisy', cause: 'usually a touch too much pressure or old rosin/bow hair — lighten the arm weight a little' },
  thin:           { symptom: 'The tone sounded thin and airy', cause: 'usually too little contact (bow too fast/light for the pressure) — add a little arm weight or slow the bow' },
  ponticello:     { symptom: 'The tone was glassy and metallic', cause: 'the bow may be too close to the bridge — move it toward the fingerboard for a fuller sound' },
  tasto:          { symptom: 'The tone was dull and lacked core', cause: 'the bow may be too close to the fingerboard — move it slightly toward the bridge for more resonance' },
  whistle:        { symptom: 'There was a whistle / squeak', cause: 'often a light, fast bow on a string crossing — keep steady weight through the change' },
  onset_scratch:  { symptom: 'Notes started scratchy before settling', cause: 'the bow is biting at the start — release a little pressure as the note begins' },
  delayed_speech: { symptom: 'Notes spoke late / started airy', cause: 'the string is slow to catch — start with a touch more weight so it speaks promptly' },
  decay:          { symptom: 'The tone thinned out toward the ends of notes', cause: 'you may be running out of bow or weight at the tip — keep arm weight to the end of the stroke' },
  flicker:        { symptom: 'The tone wavered between clean and rough', cause: 'uneven bow pressure — aim for steady, consistent weight and speed' },
};

// Short per-section labels (the `word` keeps the fault keyword; `fix` is the action).
const FAULT_BRIEF: Record<'scratch' | 'rasp' | 'thin' | 'ponticello', { word: string; fix: string }> = {
  scratch:    { word: 'scratchy',   fix: 'ease bow pressure or use more bow' },
  rasp:       { word: 'rough',      fix: 'lighten the arm weight' },
  thin:       { word: 'thin / airy', fix: 'add arm weight or rosin' },
  ponticello: { word: 'glassy',     fix: 'move the bow toward the fingerboard' },
};

function briefOf(fault: Exclude<ToneFault, 'clean'>) {
  return FAULT_BRIEF[fault as keyof typeof FAULT_BRIEF] ?? { word: 'rough', fix: 'check bow pressure and contact point' };
}

/** Seconds → "m:ss". */
function fmtTime(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Tone quality scoring (multi-feature acoustic model).
 * `pitches` must be the YIN frames from detectPitches() (provides periodicity).
 */
export function scoreToneQuality(
  samples: Float32Array,
  sampleRate: number,
  duration: number,
  pitches: PitchFrame[],
): MetricScore {
  const frames = extractToneFrameFeatures(samples, sampleRate, pitches);
  const voiced = frames.filter((f) => f.voiced);

  if (voiced.length < 3) {
    return {
      key: 'toneQuality', score: 65, flaggedTimestamps: [], severity: severityFromScore(65),
      events: [], occurrenceRate: 0,
      observationSummary: 'Too little sustained sound to assess tone quality.',
      measurementQuality: 'low',
    };
  }

  const notes = segmentNotes(frames);

  // Session score: median-weighted (robust to a noisy minority of transient frames)
  // minus a flicker penalty so pervasively uneven bowing is still punished.
  const scores = voiced.map((f) => f.score);
  const medianScore = percentile(scores, 0.5);
  const meanScore = mean(scores);
  const flickerPen = notes.length > 0 ? mean(notes.map((n) => n.flickerPenalty)) : 0;

  // Pervasive-airy penalty: when the clip's median fundamental has collapsed (and it
  // isn't simply a scratchy clip), the whole tone is thin/airy — dock the score even if
  // individual frames look "clean enough" (surface noise alone doesn't catch low rosin).
  const rel = voiced.filter((f) => f.pitchReliable);
  const medF1 = rel.length ? percentile(rel.map((f) => f.F1), 0.5) : 0.3;
  const medSF = percentile(voiced.map((f) => f.SF), 0.5);
  const airyPen =
    rel.length / voiced.length >= AIRY_MIN_RELF && medSF < SF_MED_SCRATCH && medF1 < F1_AIRY_HI
      ? clamp(((F1_AIRY_HI - medF1) / F1_AIRY_HI) * AIRY_PEN_MAX, 0, AIRY_PEN_MAX)
      : 0;

  const score = clamp(Math.round(W_MEDIAN * medianScore + W_MEAN * meanScore - flickerPen - airyPen));

  // SECTIONS: per-note faults merged into contiguous "this stretch needs work" spans.
  const sections = buildSections(notes);
  const sectionSecs = sections.reduce((acc, s) => acc + (s.endSeconds - s.startSeconds), 0);
  const occurrenceRate = Math.min(1, sectionSecs / (duration + 1e-10));

  // One flagged-timestamp per section (worst first) — this powers the per-section list
  // and timeline in the UI. Each carries an actionable label.
  const ranked = [...sections].sort((a, b) => a.scoreSum / a.noteCount - b.scoreSum / b.noteCount);
  const flaggedTimestamps: FlaggedTimestamp[] = ranked.slice(0, 6).map((s) => {
    const { word, fix } = briefOf(s.fault);
    return {
      startSeconds: s.startSeconds,
      endSeconds: s.endSeconds,
      note: `${word.charAt(0).toUpperCase()}${word.slice(1)} — ${fix}`,
    };
  });

  // Events (timeline markers): one per section, then per-note temporal faults.
  const events: TechniqueEvent[] = [];
  for (const s of sections) {
    if (events.length >= 6) break;
    events.push({ type: s.fault, startSeconds: s.startSeconds, endSeconds: s.endSeconds });
  }
  for (const n of notes) {
    if (events.length >= 8) break;
    if (n.temporalFault) events.push({ type: n.temporalFault, startSeconds: n.startS, endSeconds: n.endS });
  }

  // When the clip-level airy penalty bites hard, the tone is pervasively thin even if
  // few individual frames dipped below the section gate — lead the summary with that.
  const pervasiveAiry = airyPen >= 12;
  const observationSummary = buildObservation(score, sections, duration, pervasiveAiry);

  // Runtime-only tone-score trace for the results graph (voiced frames, capped
  // point count). Like the other metrics' timeSeries, not persisted to DB.
  const TS_MAX_POINTS = 240;
  const stride = Math.max(1, Math.ceil(voiced.length / TS_MAX_POINTS));
  const timeSeries = voiced.filter((_, i) => i % stride === 0).map((f) => ({ t: f.t, v: f.score }));

  return {
    key: 'toneQuality',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events: events.slice(0, 8),
    occurrenceRate,
    observationSummary,
    timeSeries,
  };
}

/**
 * Section-aware summary. Leads with the overall picture, then points at the specific
 * stretches that need work (with timestamps) instead of one session average.
 */
function buildObservation(score: number, sections: ToneSection[], duration: number, pervasiveAiry = false): string {
  // Worst sections first; name up to three with their timestamps.
  const ranked = [...sections].sort((a, b) => a.scoreSum / a.noteCount - b.scoreSum / b.noteCount);
  const list = ranked
    .slice(0, 3)
    .map((s) => `${fmtTime(s.startSeconds)}–${fmtTime(s.endSeconds)} (${briefOf(s.fault).word})`)
    .join(', ');

  // Pervasively thin (e.g. low rosin) — lead with that even if few frames hit the gate.
  if (pervasiveAiry) {
    const { symptom, cause } = FAULT_MESSAGE.thin;
    return sections.length > 0
      ? `${symptom} across much of the session — ${cause}. Worst around ${list}.`
      : `${symptom} across much of the session — ${cause}.`;
  }

  if (sections.length === 0) {
    return score >= 75
      ? 'Tone was clean and resonant throughout.'
      : 'Tone was a little inconsistent, but no single stretch stood out as a clear fault.';
  }

  const coverage = sections.reduce((a, s) => a + (s.endSeconds - s.startSeconds), 0) / (duration + 1e-10);

  // Pervasive: a fault covers most of the clip → lead with the fault that occupies the
  // MOST TIME (not the single worst sub-section, which can be a different fault).
  if (coverage > 0.5) {
    const byFault = new Map<Exclude<ToneFault, 'clean'>, number>();
    for (const s of sections) byFault.set(s.fault, (byFault.get(s.fault) ?? 0) + (s.endSeconds - s.startSeconds));
    const lead = [...byFault.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const { symptom, cause } = FAULT_MESSAGE[lead];
    return `${symptom} across much of the session — ${cause}. Worst around ${list}.`;
  }

  // Scattered issues. Keep it encouraging when the tone is mostly good.
  if (score >= 78) {
    return `Tone was clean overall, with a few spots to watch: ${list}.`;
  }
  const n = sections.length;
  const needs = n > 4 ? 'several stretches need work' : n === 1 ? '1 stretch needs work' : `${n} stretches need work`;
  return `Tone was uneven — ${needs} (worst: ${list}).`;
}

// ─────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}

function std(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / xs.length);
}

/** Least-squares slope of ys over their index (points per frame). */
function trendSlope(ys: number[]): number {
  const n = ys.length;
  if (n < 2) return 0;
  const xbar = (n - 1) / 2;
  const ybar = mean(ys);
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (i - xbar) * (ys[i] - ybar); den += (i - xbar) ** 2; }
  return den === 0 ? 0 : num / den;
}

function percentile(xs: number[], p: number): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const idx = clamp(Math.floor(p * (sorted.length - 1)), 0, sorted.length - 1);
  return sorted[idx];
}

