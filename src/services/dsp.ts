/**
 * Pure DSP primitives shared by the audio scoring engine.
 *
 * This module has NO React Native / Expo imports, so it can be unit-tested under
 * plain Node (e.g. `node --experimental-strip-types`). audioEngine.ts and
 * toneAnalysis.ts both import these helpers.
 */

export function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

// ─────────────────────────────────────────────────────────────
// YIN Pitch Detection
// ─────────────────────────────────────────────────────────────

export interface PitchFrame {
  frequency: number | null;
  timestamp: number;
  /** 1 − (minimum cumulative-mean-normalized difference). High = clean periodic
   *  tone, low = aperiodic/noisy (scratch). Present for every frame, voiced or not. */
  periodicity?: number;
}

/**
 * Single YIN window. Returns the detected frequency (Hz, or null) plus a
 * periodicity confidence in [0, 1] derived from the YIN difference function.
 * Periodicity is reported even when no pitch is found — a low value is itself a
 * strong signal of scratch / broadband noise.
 */
export function yinWindow(
  samples: Float32Array,
  offset: number,
  windowSize: number,
  sampleRate: number,
): { frequency: number | null; periodicity: number } {
  const half = windowSize >> 1;
  const diff = new Float32Array(half);

  // Difference function
  for (let tau = 1; tau < half; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const d = samples[offset + j] - samples[offset + j + tau];
      sum += d * d;
    }
    diff[tau] = sum;
  }

  // Cumulative mean normalized difference
  const cmndf = new Float32Array(half);
  cmndf[0] = 1;
  let runSum = 0;
  let cmndfMin = 1; // track global minimum for periodicity confidence
  for (let tau = 1; tau < half; tau++) {
    runSum += diff[tau];
    cmndf[tau] = runSum > 0 ? (diff[tau] * tau) / runSum : 1;
    if (tau >= 2 && cmndf[tau] < cmndfMin) cmndfMin = cmndf[tau];
  }

  // Periodicity: 1 → perfectly periodic, 0 → noise. cmndfMin near 0 = strong pitch.
  const periodicity = clamp(1 - cmndfMin, 0, 1);

  // Search only where a violin can actually sound. Open G is 196Hz, so the
  // floor leaves room for a badly flat G while refusing lags that could only be
  // a subharmonic; the ceiling covers high playing on the E string. Scanning
  // from tau=2 (22kHz) let a spurious short lag win the "first dip" race.
  const tauMin = Math.max(2, Math.floor(sampleRate / MAX_VIOLIN_HZ));
  const tauMax = Math.min(half - 2, Math.ceil(sampleRate / MIN_VIOLIN_HZ));

  const threshold = 0.15;
  let bestTau = -1;
  for (let tau = tauMin; tau <= tauMax; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 <= tauMax && cmndf[tau + 1] < cmndf[tau]) tau++;
      bestTau = tau;
      break;
    }
  }
  if (bestTau < 0) return { frequency: null, periodicity };

  const prev = cmndf[bestTau - 1];
  const curr = cmndf[bestTau];
  const next = cmndf[bestTau + 1];
  const denom = 2 * (2 * curr - prev - next);
  const refined = denom !== 0 ? bestTau + (prev - next) / denom : bestTau;
  const freq = sampleRate / refined;
  if (freq < MIN_VIOLIN_HZ || freq > MAX_VIOLIN_HZ) return { frequency: null, periodicity };
  return { frequency: freq, periodicity };
}

/** Below open G (196Hz) nothing on a violin can sound; the margin allows a flat G. */
const MIN_VIOLIN_HZ = 180;
/** Comfortably above the top of the E string in high positions. */
const MAX_VIOLIN_HZ = 2100;

export function detectPitches(samples: Float32Array, sampleRate: number): PitchFrame[] {
  const windowSize = 1024; // ~23ms at 44100 Hz — keeps O(N²) cost manageable
  const hopSize = Math.round(sampleRate * 0.025); // 25ms hop — finer time resolution for fast passages
  const RMS_NOISE_GATE = 0.01; // skip YIN on windows below this energy (prevents noise-floor pitch detections)
  const frames: PitchFrame[] = [];

  for (let offset = 0; offset + windowSize < samples.length; offset += hopSize) {
    let rmsSum = 0;
    for (let i = 0; i < windowSize; i++) rmsSum += samples[offset + i] ** 2;
    const rms = Math.sqrt(rmsSum / windowSize);
    if (rms >= RMS_NOISE_GATE) {
      const { frequency, periodicity } = yinWindow(samples, offset, windowSize, sampleRate);
      frames.push({ frequency, periodicity, timestamp: offset / sampleRate });
    } else {
      frames.push({ frequency: null, periodicity: 0, timestamp: offset / sampleRate });
    }
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────
// Chromatic Scale Helper
// ─────────────────────────────────────────────────────────────

/** Cents deviation of freq from the nearest chromatic note. */
export function centsFromNearestNote(freq: number): number {
  // A4 = 440 Hz = MIDI 69
  const midi = 12 * Math.log2(freq / 440) + 69;
  const nearest = 440 * Math.pow(2, (Math.round(midi) - 69) / 12);
  return 1200 * Math.log2(freq / nearest);
}

// ─────────────────────────────────────────────────────────────
// In-Place Cooley-Tukey FFT
// ─────────────────────────────────────────────────────────────

export function fftInPlace(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  // Bit-reversal permutation
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  // Butterfly passes
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -(2 * Math.PI) / len;
    const wRe = Math.cos(ang);
    const wIm = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let curRe = 1, curIm = 0;
      const half = len >> 1;
      for (let j = 0; j < half; j++) {
        const uRe = re[i + j], uIm = im[i + j];
        const vRe = re[i + j + half] * curRe - im[i + j + half] * curIm;
        const vIm = re[i + j + half] * curIm + im[i + j + half] * curRe;
        re[i + j] = uRe + vRe; im[i + j] = uIm + vIm;
        re[i + j + half] = uRe - vRe; im[i + j + half] = uIm - vIm;
        const nr = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nr;
      }
    }
  }
}

/** Returns magnitude spectrum (length = fftSize / 2). */
export function magnitudeSpectrum(samples: Float32Array, offset: number, fftSize: number): Float32Array {
  const re = new Float32Array(fftSize);
  const im = new Float32Array(fftSize);
  for (let i = 0; i < fftSize; i++) {
    const w = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (fftSize - 1))); // Hann
    re[i] = (offset + i < samples.length) ? samples[offset + i] * w : 0;
  }
  fftInPlace(re, im);
  const half = fftSize >> 1;
  const mag = new Float32Array(half);
  for (let i = 0; i < half; i++) {
    mag[i] = Math.sqrt(re[i] * re[i] + im[i] * im[i]);
  }
  return mag;
}

// ─────────────────────────────────────────────────────────────
// RMS Envelope
// ─────────────────────────────────────────────────────────────

export function computeRmsEnvelope(samples: Float32Array, windowSize: number, hopSize: number): Float32Array {
  const frames = Math.max(1, Math.floor((samples.length - windowSize) / hopSize) + 1);
  const rms = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const off = i * hopSize;
    let sum = 0;
    for (let j = 0; j < windowSize; j++) {
      const s = samples[off + j] ?? 0;
      sum += s * s;
    }
    rms[i] = Math.sqrt(sum / windowSize);
  }
  return rms;
}

// ─────────────────────────────────────────────────────────────
// Harmonic spectrum helpers (used by tone-quality analysis)
// ─────────────────────────────────────────────────────────────

/**
 * Harmonic Product Spectrum pitch estimator.
 *
 * Multiplies downsampled copies of the magnitude spectrum; the dominant peak of the
 * product falls at the fundamental even when higher harmonics are louder than the
 * fundamental bin (common in violin playing). O(maxBin × numHarmonics) per frame.
 */
export function estimateF0HPS(mag: Float32Array, sampleRate: number, fftSize: number): number | null {
  const binHz = sampleRate / fftSize;
  const minBin = Math.max(2, Math.ceil(80 / binHz));                    // low G string ≈ 196 Hz; guard DC
  const maxBin = Math.floor(Math.min(mag.length - 1, 3000 / binHz));    // highest practical violin note
  const numHarmonics = 4;

  let bestBin = minBin;
  let bestVal = -Infinity;

  for (let b = minBin; b <= maxBin; b++) {
    let product = mag[b];
    for (let h = 2; h <= numHarmonics; h++) {
      const hBin = Math.round(b * h);
      if (hBin >= mag.length) { product = 0; break; }
      product *= mag[hBin];
    }
    if (product > bestVal) { bestVal = product; bestBin = b; }
  }

  if (bestVal <= 0) return null;
  const f0 = bestBin * binHz;
  return f0 >= 80 && f0 <= 5000 ? f0 : null;
}

/**
 * Sum spectral power in harmonic partials of f0 (k = 1 … maxHarmonics).
 * A ±bwBins window around each harmonic center tolerates vibrato-induced
 * frequency wobble and mild inharmonicity.
 */
export function sumHarmonicPower(
  mag: Float32Array,
  f0: number,
  sampleRate: number,
  fftSize: number,
  maxHarmonics: number,
  bwBins: number,
): { harmonicPow: number; harmonicsFound: number } {
  const binHz = sampleRate / fftSize;
  let harmonicPow = 0;
  let harmonicsFound = 0;

  for (let k = 1; k <= maxHarmonics; k++) {
    const centerBin = Math.round((f0 * k) / binHz);
    if (centerBin >= mag.length) break;
    let bandPow = 0;
    for (let b = Math.max(0, centerBin - bwBins); b <= Math.min(mag.length - 1, centerBin + bwBins); b++) {
      bandPow += mag[b] * mag[b];
    }
    if (bandPow > 0) harmonicsFound++;
    harmonicPow += bandPow;
  }
  return { harmonicPow, harmonicsFound };
}

// ─────────────────────────────────────────────────────────────
// Onset Detection — Two-Source (Spectral Flux + Pitch Change)
// ─────────────────────────────────────────────────────────────

const SF_FFT_SIZE     = 512;   // 256 bins; resolves bow transients without 1024-pt cost
const SF_HOP_SIZE_S   = 0.01;  // 10ms hop — 2× finer than RMS hop; catches fast detaché
const SF_LOG_C        = 1000;  // log(1 + C*mag) compression (librosa default)
const SF_MEDIAN_WIN   = 10;    // ±10 frames (±100ms) local median window
const SF_MULTIPLIER   = 2.0;   // threshold = median × 2.0 + delta (raised from 1.5; reduces bow-noise triggers)
const SF_DELTA        = 0.04;  // additive floor; prevents threshold → 0 during silence

const PC_SEMITONE_THRESH  = 1.0; // pitch must move ≥ 1 semitone (vibrato is ±0.3–0.6)
const PC_STABILITY_FRAMES = 3;   // new pitch must hold 3×25ms = 75ms before confirming onset
const MERGE_DEDUP_GAP_S   = 0.050; // within 50ms → same physical event, keep earlier
export const MERGE_MIN_IOI_S = 0.120; // global minimum inter-onset (≈ 16th note at 120 BPM)

export function computeSpectralFluxOnsets(samples: Float32Array, sampleRate: number): number[] {
  const hopSize   = Math.round(sampleRate * SF_HOP_SIZE_S);
  const numFrames = Math.max(0, Math.floor((samples.length - SF_FFT_SIZE) / hopSize) + 1);
  if (numFrames < 2 * SF_MEDIAN_WIN + 3) return [];

  // Pass 1: log-magnitude spectral flux (half-wave rectified)
  const flux = new Float32Array(numFrames);
  let prevLogMag: Float32Array | null = null;
  for (let fi = 0; fi < numFrames; fi++) {
    const mag = magnitudeSpectrum(samples, fi * hopSize, SF_FFT_SIZE);
    const logMag = new Float32Array(mag.length);
    for (let k = 0; k < mag.length; k++) logMag[k] = Math.log1p(SF_LOG_C * mag[k]);
    if (prevLogMag !== null) {
      let sf = 0;
      for (let k = 0; k < logMag.length; k++) {
        const d = logMag[k] - prevLogMag[k];
        if (d > 0) sf += d;
      }
      flux[fi] = sf;
    }
    prevLogMag = logMag;
  }

  // Pass 2: adaptive threshold = local median × multiplier + delta
  const thresh = new Float32Array(numFrames);
  for (let fi = 0; fi < numFrames; fi++) {
    const win: number[] = [];
    for (let j = Math.max(0, fi - SF_MEDIAN_WIN); j <= Math.min(numFrames - 1, fi + SF_MEDIAN_WIN); j++)
      win.push(flux[j]);
    win.sort((a, b) => a - b);
    thresh[fi] = win[Math.floor(win.length / 2)] * SF_MULTIPLIER + SF_DELTA;
  }

  // Pass 3: peak-pick above threshold, enforce min gap
  const onsets: number[] = [];
  const minGapFrames = Math.round(MERGE_MIN_IOI_S / SF_HOP_SIZE_S);
  let lastFrame = -minGapFrames;
  for (let fi = 1; fi < numFrames - 1; fi++) {
    if (flux[fi] > thresh[fi]
        && flux[fi] >= flux[fi - 1] && flux[fi] >= flux[fi + 1]
        && fi - lastFrame > minGapFrames) {
      onsets.push((fi * hopSize) / sampleRate);
      lastFrame = fi;
    }
  }
  return onsets;
}

export function detectPitchChangeOnsets(pitches: PitchFrame[]): number[] {
  const onsets: number[] = [];
  const active = pitches.filter((f) => f.frequency !== null) as { frequency: number; timestamp: number }[];
  if (active.length < PC_STABILITY_FRAMES + 1) return [];

  let settledMidi = Math.round(12 * Math.log2(active[0].frequency / 440) + 69);
  let candidateMidi: number | null = null;
  let candidateStart: number | null = null;
  let candidateCount = 0;
  let prevWasNull = false;

  for (const frame of pitches) {
    if (frame.frequency === null) {
      prevWasNull = true;
      candidateMidi = null; candidateCount = 0; candidateStart = null;
      continue;
    }
    const midi = Math.round(12 * Math.log2(frame.frequency / 440) + 69);
    if (prevWasNull) {
      // Only fire if the resumed pitch is a different note; bow changes on the same
      // held pitch produce a brief YIN silence but shouldn't count as a new onset.
      if (Math.abs(midi - settledMidi) >= PC_SEMITONE_THRESH) {
        onsets.push(frame.timestamp);
      }
      settledMidi = midi; candidateMidi = null; candidateCount = 0;
      prevWasNull = false;
      continue;
    }
    prevWasNull = false;
    if (Math.abs(midi - settledMidi) < PC_SEMITONE_THRESH) {
      candidateMidi = null; candidateCount = 0; candidateStart = null;
    } else if (midi === candidateMidi) {
      candidateCount++;
      if (candidateCount >= PC_STABILITY_FRAMES) {
        onsets.push(candidateStart!);
        settledMidi = candidateMidi!;
        candidateMidi = null; candidateCount = 0; candidateStart = null;
      }
    } else {
      candidateMidi = midi; candidateCount = 1; candidateStart = frame.timestamp;
    }
  }
  return onsets;
}

export function mergeOnsets(fluxOnsets: number[], pitchOnsets: number[]): number[] {
  const combined = [...fluxOnsets, ...pitchOnsets].sort((a, b) => a - b);
  if (combined.length === 0) return [];
  const deduped: number[] = [combined[0]];
  for (let i = 1; i < combined.length; i++)
    if (combined[i] - deduped[deduped.length - 1] >= MERGE_DEDUP_GAP_S)
      deduped.push(combined[i]);
  const final: number[] = [deduped[0]];
  for (let i = 1; i < deduped.length; i++)
    if (deduped[i] - final[final.length - 1] >= MERGE_MIN_IOI_S)
      final.push(deduped[i]);
  return final;
}

export function collapseAdjacentSameNoteOnsets(onsets: number[], pitches: PitchFrame[], audioDuration: number): number[] {
  if (onsets.length < 2) return onsets;
  const active = pitches.filter((f) => f.frequency !== null) as { frequency: number; timestamp: number }[];
  if (active.length === 0) return onsets;

  const medianMidi = (startS: number, endS: number): number | null => {
    const frames = active.filter((f) => f.timestamp >= startS && f.timestamp < endS);
    if (frames.length < 3) return null;
    const midis = frames.map((f) => Math.round(12 * Math.log2(f.frequency / 440) + 69));
    midis.sort((a, b) => a - b);
    return midis[Math.floor(midis.length / 2)];
  };

  // Greedy: keep an onset only if the pitch changes across it.
  // "prevStart" tracks the start of the current merged segment (last kept onset).
  const kept: number[] = [onsets[0]];
  for (let i = 1; i < onsets.length; i++) {
    const prevStart = kept[kept.length - 1];
    const nextEnd   = onsets[i + 1] ?? audioDuration;
    const midiA = medianMidi(prevStart, onsets[i]);
    const midiB = medianMidi(onsets[i], nextEnd);
    if (midiA !== null && midiB !== null && midiA === midiB) continue; // same note — collapse
    kept.push(onsets[i]);
  }
  return kept;
}
