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

  // Find first valley below threshold, refined with parabolic interpolation
  const threshold = 0.15;
  for (let tau = 2; tau < half - 1; tau++) {
    if (cmndf[tau] < threshold) {
      while (tau + 1 < half - 1 && cmndf[tau + 1] < cmndf[tau]) tau++;
      const prev = cmndf[tau - 1];
      const curr = cmndf[tau];
      const next = cmndf[tau + 1];
      const denom = 2 * (2 * curr - prev - next);
      const refined = denom !== 0 ? tau + (prev - next) / denom : tau;
      const freq = sampleRate / refined;
      if (freq >= 80 && freq <= 5000) return { frequency: freq, periodicity };
    }
  }
  return { frequency: null, periodicity };
}

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
