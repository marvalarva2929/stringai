/**
 * On-device audio DSP engine.
 *
 * Entry point: analyzeWavFile(uri, instrument, duration) → MetricScore[]
 *
 * Only WAV/LinearPCM files can be fully analyzed. expo-av records WAV on iOS
 * when configured with linearPCMBitDepth. Android records AAC/M4A — parsing
 * will fail and the caller should fall back gracefully.
 */

import { File } from 'expo-file-system';
import { MetricScore, TechniqueEvent, FlaggedTimestamp, severityFromScore, AudioAnalysisOutput, RawAudioSignals } from '../types/analysis';
import { analyzeIntonation } from '../lib/intonationAnalysis';
import { InstrumentId } from '../types/instrument';
import { extractAudioFromVideo } from './videoAudioExtractor';

// ─────────────────────────────────────────────────────────────
// WAV Parser
// ─────────────────────────────────────────────────────────────

interface WavData {
  samples: Float32Array; // mono, normalized to [-1, 1]
  sampleRate: number;
  duration: number; // seconds
}

function parseWav(bytes: Uint8Array): WavData | null {
  if (bytes.length < 44) return null;

  const id = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3]);
  const fmt = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]);
  if (id !== 'RIFF' || fmt !== 'WAVE') return null;

  const view = new DataView(bytes.buffer, bytes.byteOffset);

  let sampleRate = 44100;
  let bitsPerSample = 16;
  let numChannels = 1;
  let dataOffset = -1;
  let dataSize = 0;
  let offset = 12;

  while (offset < bytes.length - 8) {
    const chunkId = String.fromCharCode(bytes[offset], bytes[offset + 1], bytes[offset + 2], bytes[offset + 3]);
    const chunkSize = view.getUint32(offset + 4, true);

    if (chunkId === 'fmt ') {
      numChannels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bitsPerSample = view.getUint16(offset + 22, true);
    } else if (chunkId === 'data') {
      dataOffset = offset + 8;
      dataSize = Math.min(chunkSize, bytes.length - dataOffset);
      break;
    }

    offset += 8 + chunkSize;
    if (chunkSize % 2 !== 0) offset++;
  }

  if (dataOffset < 0) return null;

  const bytesPerSample = bitsPerSample >> 3;
  const totalSamples = Math.floor(dataSize / bytesPerSample / numChannels);
  const samples = new Float32Array(totalSamples);
  const scale = bitsPerSample === 8 ? 128 : bitsPerSample === 16 ? 32768 : 2147483648;

  for (let i = 0; i < totalSamples; i++) {
    let s = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const byteIdx = dataOffset + (i * numChannels + ch) * bytesPerSample;
      if (bitsPerSample === 8) {
        s += (bytes[byteIdx] - 128) / scale;
      } else if (bitsPerSample === 16) {
        s += view.getInt16(byteIdx, true) / scale;
      } else if (bitsPerSample === 32) {
        s += view.getInt32(byteIdx, true) / scale;
      }
    }
    samples[i] = s / numChannels;
  }

  return { samples, sampleRate, duration: totalSamples / sampleRate };
}

// ─────────────────────────────────────────────────────────────
// YIN Pitch Detection
// ─────────────────────────────────────────────────────────────

interface PitchFrame {
  frequency: number | null;
  timestamp: number;
}

// Single YIN window. Returns detected frequency in Hz, or null.
function yinWindow(
  samples: Float32Array,
  offset: number,
  windowSize: number,
  sampleRate: number,
): number | null {
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
  for (let tau = 1; tau < half; tau++) {
    runSum += diff[tau];
    cmndf[tau] = runSum > 0 ? (diff[tau] * tau) / runSum : 1;
  }

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
      if (freq >= 80 && freq <= 5000) return freq;
    }
  }
  return null;
}

function detectPitches(samples: Float32Array, sampleRate: number): PitchFrame[] {
  const windowSize = 1024; // ~23ms at 44100 Hz — keeps O(N²) cost manageable
  const hopSize = Math.round(sampleRate * 0.025); // 25ms hop (was 50ms) — finer time resolution for fast passages
  const RMS_NOISE_GATE = 0.01; // skip YIN on windows below this energy (prevents noise-floor pitch detections)
  const frames: PitchFrame[] = [];

  for (let offset = 0; offset + windowSize < samples.length; offset += hopSize) {
    let rmsSum = 0;
    for (let i = 0; i < windowSize; i++) rmsSum += samples[offset + i] ** 2;
    const rms = Math.sqrt(rmsSum / windowSize);
    frames.push({
      frequency: rms >= RMS_NOISE_GATE ? yinWindow(samples, offset, windowSize, sampleRate) : null,
      timestamp: offset / sampleRate,
    });
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────
// Chromatic Scale Helper
// ─────────────────────────────────────────────────────────────

// Cents deviation of freq from the nearest chromatic note.
function centsFromNearestNote(freq: number): number {
  // A4 = 440 Hz = MIDI 69
  const midi = 12 * Math.log2(freq / 440) + 69;
  const nearest = 440 * Math.pow(2, (Math.round(midi) - 69) / 12);
  return 1200 * Math.log2(freq / nearest);
}

// ─────────────────────────────────────────────────────────────
// In-Place Cooley-Tukey FFT
// ─────────────────────────────────────────────────────────────

function fftInPlace(re: Float32Array, im: Float32Array): void {
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

// Returns magnitude spectrum (length = fftSize / 2).
function magnitudeSpectrum(samples: Float32Array, offset: number, fftSize: number): Float32Array {
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

function computeRmsEnvelope(samples: Float32Array, windowSize: number, hopSize: number): Float32Array {
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
// Onset Detection
// ─────────────────────────────────────────────────────────────

function detectOnsets(rms: Float32Array, hopSize: number, sampleRate: number): number[] {
  const onsets: number[] = [];
  const minGapFrames = Math.round(0.1 * sampleRate / hopSize); // min 100ms gap
  let lastOnset = -minGapFrames;

  for (let i = 1; i < rms.length; i++) {
    if (rms[i] - rms[i - 1] > 0.05 && i - lastOnset > minGapFrames) {
      onsets.push((i * hopSize) / sampleRate);
      lastOnset = i;
    }
  }
  return onsets;
}

// ─────────────────────────────────────────────────────────────
// Scoring Functions
// ─────────────────────────────────────────────────────────────

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function scorePitchAccuracy(pitches: PitchFrame[], duration: number): MetricScore {
  const detected = pitches.filter((p) => p.frequency !== null);
  if (detected.length === 0) {
    return { key: 'pitchAccuracy', score: 50, flaggedTimestamps: [], severity: severityFromScore(50), events: [], occurrenceRate: 0, observationSummary: 'No pitch detected — check audio recording.' };
  }

  const flagged: FlaggedTimestamp[] = [];
  let inTune = 0;
  let flagStart: number | null = null;

  for (const f of detected) {
    const cents = Math.abs(centsFromNearestNote(f.frequency!));
    if (cents <= 25) {
      inTune++;
      if (flagStart !== null) {
        if (f.timestamp - flagStart > 0.1) {
          flagged.push({ startSeconds: flagStart, endSeconds: f.timestamp, note: 'Intonation off' });
        }
        flagStart = null;
      }
    } else {
      if (flagStart === null) flagStart = f.timestamp;
    }
  }
  if (flagStart !== null) {
    flagged.push({ startSeconds: flagStart, endSeconds: duration, note: 'Intonation off' });
  }

  const score = clamp(Math.round((inTune / detected.length) * 100));
  const occurrenceRate = 1 - inTune / detected.length;
  const events: TechniqueEvent[] = flagged.slice(0, 6).map((ts) => ({ type: 'out_of_tune', startSeconds: ts.startSeconds, endSeconds: ts.endSeconds }));
  const outOfTuneCount = flagged.length;
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    outOfTuneCount === 0
      ? 'Intonation was accurate throughout the session.'
      : ratePct >= 30
      ? `Intonation was off in ${ratePct}% of detected notes.`
      : `${outOfTuneCount} ${outOfTuneCount === 1 ? 'passage was' : 'passages were'} noticeably out of tune.`;
  return { key: 'pitchAccuracy', score, flaggedTimestamps: flagged.slice(0, 6), severity: severityFromScore(score), events, occurrenceRate, observationSummary };
}

function scoreIntonationStability(pitches: PitchFrame[]): MetricScore {
  const detected = pitches.filter((p) => p.frequency !== null);
  if (detected.length < 3) {
    return { key: 'intonationStability', score: 60, flaggedTimestamps: [], severity: severityFromScore(60), events: [], occurrenceRate: 0, observationSummary: 'Insufficient notes to assess pitch stability.' };
  }

  // Std deviation of per-frame deviation from nearest note
  const devs = detected.map((p) => centsFromNearestNote(p.frequency!));
  const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
  const variance = devs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / devs.length;
  const stdCents = Math.sqrt(variance);

  // stdCents ≈ 0 → perfect stability (100). stdCents ≈ 30 → very wobbly (0).
  const score = clamp(Math.round(100 - stdCents * 3));
  const occurrenceRate = Math.min(1, stdCents / 30);
  const observationSummary =
    stdCents < 8
      ? 'Sustained notes held their pitch steadily.'
      : stdCents < 18
      ? `Some pitch wavering on held notes (avg ${Math.round(stdCents)} cents variation).`
      : `Significant pitch wavering on held notes (avg ${Math.round(stdCents)} cents variation).`;
  return { key: 'intonationStability', score, flaggedTimestamps: [], severity: severityFromScore(score), events: [], occurrenceRate, observationSummary };
}

function scoreToneQuality(samples: Float32Array, sampleRate: number, duration: number): MetricScore {
  const fftSize = 2048;
  const hopSize = Math.round(sampleRate * 0.1); // 100ms
  const flagged: FlaggedTimestamp[] = [];
  let goodFrames = 0;
  let totalFrames = 0;
  let flagStart: number | null = null;

  for (let offset = 0; offset + fftSize < samples.length; offset += hopSize) {
    const mag = magnitudeSpectrum(samples, offset, fftSize);
    const t = offset / sampleRate;

    let maxMag = 0;
    let maxBin = 1;
    let totalPow = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      if (mag[i] > maxMag) { maxMag = mag[i]; maxBin = i; }
    }

    if (maxMag < 0.002) { totalFrames++; continue; } // silence

    const fundamentalPow = mag[maxBin] * mag[maxBin];
    const ratio = fundamentalPow / (totalPow + 1e-10);
    const isGood = ratio > 0.08 && ratio < 0.95; // noisy <0.08, very pure harmonic >0.95 is fine

    totalFrames++;
    if (isGood) {
      goodFrames++;
      if (flagStart !== null) {
        flagged.push({ startSeconds: flagStart, endSeconds: t, note: 'Tone quality issue' });
        flagStart = null;
      }
    } else {
      if (flagStart === null) flagStart = t;
    }
  }
  if (flagStart !== null) {
    flagged.push({ startSeconds: flagStart, endSeconds: duration, note: 'Tone quality issue' });
  }

  const score = totalFrames > 0 ? clamp(Math.round((goodFrames / totalFrames) * 100)) : 65;
  const occurrenceRate = totalFrames > 0 ? 1 - goodFrames / totalFrames : 0;
  const events: TechniqueEvent[] = flagged.slice(0, 4).map((ts) => ({ type: 'scratchy_tone', startSeconds: ts.startSeconds, endSeconds: ts.endSeconds }));
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    occurrenceRate < 0.1
      ? 'Tone was full and resonant throughout.'
      : ratePct >= 40
      ? `Scratchy or thin tone in ${ratePct}% of the session.`
      : `Some tone quality issues — ${ratePct}% of the session.`;
  return { key: 'toneQuality', score, flaggedTimestamps: flagged.slice(0, 4), severity: severityFromScore(score), events, occurrenceRate, observationSummary };
}

function scoreBowSmoothness(rms: Float32Array, hopSize: number, sampleRate: number): MetricScore {
  if (rms.length < 4) {
    return { key: 'bowSmoothness', score: 70, flaggedTimestamps: [], severity: severityFromScore(70), events: [], occurrenceRate: 0, observationSummary: 'Insufficient audio to assess bow smoothness.' };
  }

  const flagged: FlaggedTimestamp[] = [];
  let abrupt = 0;

  for (let i = 2; i < rms.length; i++) {
    const change = Math.abs(rms[i] - rms[i - 1]);
    if (change > 0.12 && Math.abs(rms[i - 1] - rms[i - 2]) <= 0.12) {
      abrupt++;
      const t = (i * hopSize) / sampleRate;
      if (flagged.length < 5) {
        flagged.push({ startSeconds: Math.max(0, t - 0.05), endSeconds: t + 0.1, note: 'Abrupt bow change' });
      }
    }
  }

  const score = clamp(Math.round(100 - (abrupt / Math.max(rms.length, 1)) * 500));
  const occurrenceRate = Math.min(1, abrupt / Math.max(rms.length / 20, 1));
  const events: TechniqueEvent[] = flagged.map((ts) => ({ type: 'abrupt_bow_change', startSeconds: ts.startSeconds, endSeconds: ts.endSeconds }));
  const observationSummary =
    abrupt === 0
      ? 'Bow changes were smooth throughout.'
      : abrupt === 1
      ? '1 abrupt bow change detected.'
      : `${abrupt} abrupt bow changes detected.`;
  return { key: 'bowSmoothness', score, flaggedTimestamps: flagged, severity: severityFromScore(score), events, occurrenceRate, observationSummary };
}

function scoreRhythmAccuracy(onsets: number[]): MetricScore {
  if (onsets.length < 3) {
    return { key: 'rhythmAccuracy', score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0, observationSummary: 'Too few notes detected to assess rhythm.' };
  }

  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);

  const mean = iois.reduce((a, b) => a + b, 0) / iois.length;
  const variance = iois.reduce((acc, d) => acc + (d - mean) ** 2, 0) / iois.length;
  const cv = Math.sqrt(variance) / (mean + 1e-10); // coefficient of variation; 0 = perfectly regular

  const score = clamp(Math.round((1 - Math.min(cv, 1)) * 100));
  const occurrenceRate = Math.min(1, cv);
  const observationSummary =
    cv < 0.15
      ? 'Rhythm was steady throughout the session.'
      : cv < 0.3
      ? 'Some rhythmic inconsistency — note durations varied more than expected.'
      : 'Rhythm was significantly unsteady — note durations varied widely.';
  return { key: 'rhythmAccuracy', score, flaggedTimestamps: [], severity: severityFromScore(score), events: [], occurrenceRate, observationSummary };
}

function scoreDynamicControl(rms: Float32Array, hopSize: number, sampleRate: number): MetricScore {
  if (rms.length < 10) {
    return { key: 'dynamicControl', score: 70, flaggedTimestamps: [], severity: severityFromScore(70), events: [], occurrenceRate: 0, observationSummary: 'Insufficient audio to assess dynamics.' };
  }

  // Low fast-fluctuation variance → good intentional dynamics
  const hw = 10;
  let fastVar = 0;
  for (let i = 0; i < rms.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - hw); j <= Math.min(rms.length - 1, i + hw); j++) {
      sum += rms[j]; cnt++;
    }
    const d = rms[i] - sum / cnt;
    fastVar += d * d;
  }
  fastVar /= rms.length;

  const score = clamp(Math.round((1 - Math.min(fastVar * 80, 1)) * 100));
  const occurrenceRate = Math.min(1, fastVar * 80);
  const observationSummary =
    score >= 75
      ? 'Good dynamic variety — clear volume variation throughout.'
      : score >= 55
      ? 'Dynamics were somewhat limited — not much volume variation.'
      : 'Dynamics were relatively flat throughout the session.';
  return { key: 'dynamicControl', score, flaggedTimestamps: [], severity: severityFromScore(score), events: [], occurrenceRate, observationSummary };
}

function scoreVibrato(pitches: PitchFrame[]): MetricScore {
  const detected = pitches.filter((p) => p.frequency !== null);
  if (detected.length < 20) {
    return { key: 'vibrato', score: 50, flaggedTimestamps: [], severity: severityFromScore(50), events: [], occurrenceRate: 0.5, observationSummary: 'Insufficient sustained notes to assess vibrato.' };
  }

  // Count zero-crossings in the pitch derivative — vibrato at ~5 Hz produces
  // 2 * 5 * duration crossings; compare to actual crossings.
  const diffs: number[] = [];
  for (let i = 1; i < detected.length; i++) {
    diffs.push(detected[i].frequency! - detected[i - 1].frequency!);
  }

  let crossings = 0;
  for (let i = 1; i < diffs.length; i++) {
    if (diffs[i] * diffs[i - 1] < 0) crossings++;
  }

  const duration = detected[detected.length - 1].timestamp - detected[0].timestamp;
  const expected = 2 * 5 * duration;
  const vibratoRatio = crossings / Math.max(expected, 1);
  const score = clamp(Math.round(vibratoRatio * 80));
  const occurrenceRate = Math.max(0, 1 - vibratoRatio);
  const observationSummary =
    vibratoRatio >= 0.6
      ? 'Vibrato was present and consistent.'
      : vibratoRatio >= 0.25
      ? 'Vibrato was present but inconsistent.'
      : 'Vibrato was mostly absent during the session.';
  return { key: 'vibrato', score, flaggedTimestamps: [], severity: severityFromScore(score), events: [], occurrenceRate, observationSummary };
}

// ─────────────────────────────────────────────────────────────
// Raw signal extraction for note fusion
// ─────────────────────────────────────────────────────────────

// Returns per-frame FFT fundamental ratio — same window as scoreToneQuality
// but as a time-series for noteFusion.ts to consume per note.
function computeToneFrames(
  samples: Float32Array,
  sampleRate: number,
): { fundamentalRatio: number; timestamp: number }[] {
  const fftSize = 2048;
  const hopSize = Math.round(sampleRate * 0.05); // 50ms
  const frames: { fundamentalRatio: number; timestamp: number }[] = [];

  for (let offset = 0; offset + fftSize < samples.length; offset += hopSize) {
    const mag = magnitudeSpectrum(samples, offset, fftSize);
    let maxMag = 0, maxBin = 1, totalPow = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      if (mag[i] > maxMag) { maxMag = mag[i]; maxBin = i; }
    }
    const fundamentalRatio = maxMag < 0.002
      ? 0
      : (mag[maxBin] * mag[maxBin]) / (totalPow + 1e-10);
    frames.push({ fundamentalRatio, timestamp: offset / sampleRate });
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────
// Debug Info (calibration helper — not used in production)
// ─────────────────────────────────────────────────────────────

export interface AudioDebugInfo {
  wavInfo: { sampleRate: number; duration: number; totalSamples: number };
  pitchAccuracy: {
    totalFrames: number;
    detectedFrames: number;
    detectionRate: number;
    avgCentsDeviation: number;
    inTuneRatio: number;
    inTuneCentsThreshold: number;
  };
  intonationStability: { stdCents: number };
  toneQuality: {
    avgFundamentalRatio: number;
    goodFrameRatio: number;
    silentFrameCount: number;
    lowerBound: number;
    upperBound: number;
  };
  bowSmoothness: {
    abruptChangeCount: number;
    rmsFrameCount: number;
    abruptRatio: number;
    changeThreshold: number;
  };
  rhythmAccuracy: { onsetCount: number; meanIoi: number; cvIoi: number };
  dynamicControl: { fastVar: number };
  vibrato: { zeroCrossings: number; expectedCrossings: number; vibratoRatio: number };
}

async function analyzeWavFileWithDebug(
  fileUri: string,
  _instrument: InstrumentId,
  _durationSeconds: number,
): Promise<{ scores: MetricScore[]; debug: AudioDebugInfo; intonationAnalysis: import('../types/analysis').IntonationAnalysis }> {
  const b64 = await new File(fileUri).base64();
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const wav = parseWav(bytes);
  if (!wav) throw new Error('NOT_WAV');

  const { samples, sampleRate, duration } = wav;
  const pitches = detectPitches(samples, sampleRate);
  const rmsHop = Math.round(sampleRate * 0.02);
  const rmsWin = Math.round(sampleRate * 0.05);
  const rms = computeRmsEnvelope(samples, rmsWin, rmsHop);
  const onsets = detectOnsets(rms, rmsHop, sampleRate);

  const scores = [
    scorePitchAccuracy(pitches, duration),
    scoreIntonationStability(pitches),
    scoreToneQuality(samples, sampleRate, duration),
    scoreBowSmoothness(rms, rmsHop, sampleRate),
    scoreRhythmAccuracy(onsets),
    scoreDynamicControl(rms, rmsHop, sampleRate),
    scoreVibrato(pitches),
  ];

  // Pitch
  const detected = pitches.filter((p) => p.frequency !== null);
  const IN_TUNE_CENTS = 25;
  let inTuneCount = 0;
  let totalCentsDev = 0;
  for (const f of detected) {
    const cents = Math.abs(centsFromNearestNote(f.frequency!));
    totalCentsDev += cents;
    if (cents <= IN_TUNE_CENTS) inTuneCount++;
  }

  // Intonation stability
  let stdCents = 0;
  if (detected.length >= 3) {
    const devs = detected.map((p) => centsFromNearestNote(p.frequency!));
    const mean = devs.reduce((a, b) => a + b, 0) / devs.length;
    const variance = devs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / devs.length;
    stdCents = Math.sqrt(variance);
  }

  // Tone quality
  const fftSize = 2048;
  const tqHop = Math.round(sampleRate * 0.1);
  let tqGood = 0, tqTotal = 0, tqSilent = 0, tqSumRatio = 0;
  for (let offset = 0; offset + fftSize < samples.length; offset += tqHop) {
    const mag = magnitudeSpectrum(samples, offset, fftSize);
    let maxMag = 0, maxBin = 1, totalPow = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      if (mag[i] > maxMag) { maxMag = mag[i]; maxBin = i; }
    }
    tqTotal++;
    if (maxMag < 0.002) { tqSilent++; continue; }
    const ratio = (mag[maxBin] * mag[maxBin]) / (totalPow + 1e-10);
    tqSumRatio += ratio;
    if (ratio > 0.08 && ratio < 0.95) tqGood++;
  }
  const tqNonSilent = tqTotal - tqSilent;

  // Bow smoothness
  let abrupt = 0;
  for (let i = 2; i < rms.length; i++) {
    if (Math.abs(rms[i] - rms[i - 1]) > 0.12 && Math.abs(rms[i - 1] - rms[i - 2]) <= 0.12) abrupt++;
  }

  // Rhythm
  let meanIoi = 0, cvIoi = 0;
  if (onsets.length >= 3) {
    const iois = onsets.slice(1).map((t, i) => t - onsets[i]);
    meanIoi = iois.reduce((a, b) => a + b, 0) / iois.length;
    const v = iois.reduce((acc, d) => acc + (d - meanIoi) ** 2, 0) / iois.length;
    cvIoi = Math.sqrt(v) / (meanIoi + 1e-10);
  }

  // Dynamic control
  const hw = 10;
  let fastVar = 0;
  for (let i = 0; i < rms.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - hw); j <= Math.min(rms.length - 1, i + hw); j++) { sum += rms[j]; cnt++; }
    const d = rms[i] - sum / cnt;
    fastVar += d * d;
  }
  fastVar /= rms.length;

  // Vibrato
  let zeroCrossings = 0, expectedCrossings = 0;
  if (detected.length >= 20) {
    const diffs = detected.slice(1).map((f, i) => f.frequency! - detected[i].frequency!);
    for (let i = 1; i < diffs.length; i++) {
      if (diffs[i] * diffs[i - 1] < 0) zeroCrossings++;
    }
    expectedCrossings = Math.round(2 * 5 * (detected[detected.length - 1].timestamp - detected[0].timestamp));
  }

  const debug: AudioDebugInfo = {
    wavInfo: { sampleRate, duration, totalSamples: samples.length },
    pitchAccuracy: {
      totalFrames: pitches.length,
      detectedFrames: detected.length,
      detectionRate: pitches.length > 0 ? detected.length / pitches.length : 0,
      avgCentsDeviation: detected.length > 0 ? totalCentsDev / detected.length : 0,
      inTuneRatio: detected.length > 0 ? inTuneCount / detected.length : 0,
      inTuneCentsThreshold: IN_TUNE_CENTS,
    },
    intonationStability: { stdCents },
    toneQuality: {
      avgFundamentalRatio: tqNonSilent > 0 ? tqSumRatio / tqNonSilent : 0,
      goodFrameRatio: tqTotal > 0 ? tqGood / tqTotal : 0,
      silentFrameCount: tqSilent,
      lowerBound: 0.08,
      upperBound: 0.95,
    },
    bowSmoothness: {
      abruptChangeCount: abrupt,
      rmsFrameCount: rms.length,
      abruptRatio: rms.length > 0 ? abrupt / rms.length : 0,
      changeThreshold: 0.12,
    },
    rhythmAccuracy: { onsetCount: onsets.length, meanIoi, cvIoi },
    dynamicControl: { fastVar },
    vibrato: { zeroCrossings, expectedCrossings, vibratoRatio: expectedCrossings > 0 ? zeroCrossings / expectedCrossings : 0 },
  };

  const intonationAnalysis = analyzeIntonation(pitches);
  return { scores, debug, intonationAnalysis };
}

// ─────────────────────────────────────────────────────────────
// Public Entry Points
// ─────────────────────────────────────────────────────────────

const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm'];

function isVideoUri(uri: string): boolean {
  // ph:// = Photos library asset (Expo SDK 54 image picker on iOS 14+)
  // content:// = Android media store URIs
  if (uri.startsWith('ph://') || uri.startsWith('content://')) return true;
  const lower = uri.toLowerCase().split('?')[0];
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

/**
 * Analyze any media file.
 *
 * WAV files: full on-device DSP — real scores.
 * Video files (MP4, MOV…): extracts audio via AVFoundation (iOS) then analyzes.
 *   Falls back to throwing VIDEO_UPLOADED if extraction is not available.
 * Other audio (M4A…): throws NOT_WAV so the caller can fall back to mock data.
 */
export async function analyzeMediaFile(
  fileUri: string,
  instrument: InstrumentId,
  durationSeconds: number,
): Promise<AudioAnalysisOutput> {
  if (isVideoUri(fileUri)) {
    try {
      const wavUri = await extractAudioFromVideo(fileUri);
      return analyzeWavFile(wavUri, instrument, durationSeconds);
    } catch (extractErr: any) {
      console.warn('[VideoAudioExtractor] extraction failed:', extractErr?.code, extractErr?.message ?? extractErr);
      if (extractErr?.message === 'VIDEO_NO_EXTRACTOR') {
        throw new Error('NOT_WAV');
      }
      throw new Error('VIDEO_UPLOADED');
    }
  }
  return analyzeWavFile(fileUri, instrument, durationSeconds);
}

/**
 * Detect the dominant pitch in a short WAV or video file.
 * Returns the median detected frequency in Hz, or null if no pitch found.
 * Used by the real-time tuner — call this on 250–400ms clips in a loop.
 */
export async function detectPitchFromFile(uri: string): Promise<number | null> {
  try {
    let wavUri = uri;
    if (isVideoUri(uri)) {
      try {
        wavUri = await extractAudioFromVideo(uri);
      } catch {
        return null;
      }
    }
    const b64 = await new File(wavUri).base64();
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const wav = parseWav(bytes);
    if (!wav) return null;
    const pitches = detectPitches(wav.samples, wav.sampleRate);
    const detected = pitches.filter((p) => p.frequency !== null).map((p) => p.frequency!);
    if (detected.length === 0) return null;
    const sorted = [...detected].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  } catch {
    return null;
  }
}

/**
 * Debug variant — same as analyzeMediaFile but also returns raw intermediate
 * values for each metric. Use in the calibration debug screen only.
 */
export async function analyzeMediaFileWithDebug(
  fileUri: string,
  instrument: InstrumentId,
  durationSeconds: number,
): Promise<{ scores: MetricScore[]; debug: AudioDebugInfo; intonationAnalysis: import('../types/analysis').IntonationAnalysis }> {
  if (isVideoUri(fileUri)) {
    try {
      const wavUri = await extractAudioFromVideo(fileUri);
      return analyzeWavFileWithDebug(wavUri, instrument, durationSeconds);
    } catch (extractErr: any) {
      console.warn('[VideoAudioExtractor] extraction failed:', extractErr?.code, extractErr?.message ?? extractErr);
      if (extractErr?.message === 'VIDEO_NO_EXTRACTOR') throw new Error('NOT_WAV');
      throw new Error('VIDEO_UPLOADED');
    }
  }
  return analyzeWavFileWithDebug(fileUri, instrument, durationSeconds);
}

/**
 * Analyze a WAV audio file and return MetricScore[] for all audio metrics.
 *
 * Throws 'NOT_WAV' if the file cannot be parsed as WAV (e.g. M4A from Android).
 * The caller in analysis.ts catches this and falls back to mock data.
 */
export async function analyzeWavFile(
  fileUri: string,
  _instrument: InstrumentId,
  _durationSeconds: number,
): Promise<AudioAnalysisOutput> {
  const b64 = await new File(fileUri).base64();

  // Decode base64 → Uint8Array
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const wav = parseWav(bytes);
  if (!wav) throw new Error('NOT_WAV');

  const { samples, sampleRate, duration } = wav;

  const pitches = detectPitches(samples, sampleRate);
  const rmsHop = Math.round(sampleRate * 0.02); // 20ms
  const rmsWin = Math.round(sampleRate * 0.05); // 50ms
  const rms = computeRmsEnvelope(samples, rmsWin, rmsHop);
  const onsets = detectOnsets(rms, rmsHop, sampleRate);

  const toneFrames = computeToneFrames(samples, sampleRate);

  const metrics = [
    scorePitchAccuracy(pitches, duration),
    scoreIntonationStability(pitches),
    scoreToneQuality(samples, sampleRate, duration),
    scoreBowSmoothness(rms, rmsHop, sampleRate),
    scoreRhythmAccuracy(onsets),
    scoreDynamicControl(rms, rmsHop, sampleRate),
    scoreVibrato(pitches),
  ];

  const intonationAnalysis = analyzeIntonation(pitches);

  const rawSignals: RawAudioSignals = {
    pitchFrames: pitches,
    rmsFrames: Array.from(rms).map((value, i) => ({ value, timestamp: (i * rmsHop) / sampleRate })),
    toneFrames,
    onsetTimestamps: onsets,
    sampleRate,
    duration,
  };

  return { metrics, intonationAnalysis, rawSignals };
}
