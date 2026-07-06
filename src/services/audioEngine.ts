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
import { MetricScore, TechniqueEvent, FlaggedTimestamp, severityFromScore, AudioAnalysisOutput, RawAudioSignals, VibratoNoteResult, VibratoAnalysis, DynDebugInfo, DynPhraseDebug, PhraseShape, RhythmAnalysis, RhythmFlaggedRegion } from '../types/analysis';
import { analyzeIntonation } from '../lib/intonationAnalysis';
import { InstrumentId } from '../types/instrument';
import { extractAudioFromVideo } from './videoAudioExtractor';
import {
  PitchFrame,
  clamp,
  detectPitches,
  centsFromNearestNote,
  magnitudeSpectrum,
  computeRmsEnvelope,
  estimateF0HPS,
  sumHarmonicPower,
  computeSpectralFluxOnsets,
  detectPitchChangeOnsets,
  mergeOnsets,
  collapseAdjacentSameNoteOnsets,
} from './dsp';
import { scoreToneQuality } from './toneAnalysis';
import {
  scoreIntonationStability,
  computeIntonationStability,
  classifyVibratoSegment,
  VIBRATO_MIN_SEGMENT_S,
  VIBRATO_MIN_FRAMES,
} from './pitchContour';

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

// PitchFrame, YIN pitch detection (yinWindow/detectPitches), centsFromNearestNote,
// the FFT (fftInPlace/magnitudeSpectrum), computeRmsEnvelope, and the two-source
// onset detector (spectral flux + pitch change + merge/collapse) now live in
// ./dsp (pure, unit-testable). They are imported at the top of this file.

// ─────────────────────────────────────────────────────────────
// Scoring Functions
// ─────────────────────────────────────────────────────────────
// (clamp is imported from ./dsp)

function scorePitchAccuracy(pitches: PitchFrame[], duration: number): MetricScore {
  const detected = pitches.filter((p) => p.frequency !== null);
  if (detected.length === 0) {
    return { key: 'pitchAccuracy', score: 50, flaggedTimestamps: [], severity: severityFromScore(50), events: [], occurrenceRate: 0, observationSummary: 'No pitch detected — check audio recording.' };
  }

  // Signed cents: negative = flat, positive = sharp.
  // centsFromNearestNote already returns a signed value — don't discard the sign.
  const signedDevs = detected.map((p) => centsFromNearestNote(p.frequency!));
  const absDevs = signedDevs.map(Math.abs);

  // Severity-weighted per-frame score: gradual penalty from 10¢ → 50¢.
  // Previously a 20¢ flat note scored 100/100 (within 25¢ threshold).
  // Now it scores 75/100 — still good, but not perfect.
  const frameScores = absDevs.map((c) => {
    if (c <= 10) return 100;
    if (c <= 50) return 100 - (c - 10) * 2.5; // 100 at 10¢ → 0 at 50¢
    return 0;
  });
  const baseScore = frameScores.reduce((a, b) => a + b, 0) / frameScores.length;

  // Systematic bias: a student consistently 20¢ flat would previously score 100.
  // Penalize directional offset — it indicates a physical setup problem, not a momentary lapse.
  const meanBias = signedDevs.reduce((a, b) => a + b, 0) / signedDevs.length;
  const biasPenalty = clamp(Math.abs(meanBias) * 1.5, 0, 35);

  // Per-note-name tracking: find which specific pitches are chronically off.
  // Gives actionable feedback: "F# is consistently 22¢ flat — check your second finger."
  const noteDeviations = new Map<number, number[]>(); // MIDI note → [signed cents]
  for (const p of detected) {
    const midi = Math.round(12 * Math.log2(p.frequency! / 440) + 69);
    if (!noteDeviations.has(midi)) noteDeviations.set(midi, []);
    noteDeviations.get(midi)!.push(centsFromNearestNote(p.frequency!));
  }
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const worstNotes = [...noteDeviations.entries()]
    .map(([midi, devs]) => ({
      name: NOTE_NAMES[midi % 12],
      mean: devs.reduce((a, b) => a + b, 0) / devs.length,
      count: devs.length,
    }))
    .filter((n) => n.count >= 4 && Math.abs(n.mean) > 15)
    .sort((a, b) => Math.abs(b.mean) - Math.abs(a.mean));

  // Open-string resonance: notes that are unisons/octaves of G/D/A/E should ring sympathetically.
  // These have an acoustic tuning reference — tighter 15¢ tolerance, and misses factor into summary.
  const OPEN_HZ = [196.0, 293.7, 440.0, 659.3]; // G3, D4, A4, E5
  let resonanceMisses = 0;
  let resonanceChecked = 0;
  for (const p of detected) {
    const freq = p.frequency!;
    const isResonant = OPEN_HZ.some((open) =>
      [0.5, 1, 2, 4].some((ratio) => Math.abs(1200 * Math.log2(freq / (open * ratio))) < 30),
    );
    if (isResonant) {
      resonanceChecked++;
      if (Math.abs(centsFromNearestNote(freq)) > 15) resonanceMisses++;
    }
  }
  const resonanceMissRate = resonanceChecked > 5 ? resonanceMisses / resonanceChecked : 0;

  // Time-region flagging with direction — a teacher always says "sharp" or "flat", not just "off"
  const flagged: FlaggedTimestamp[] = [];
  let flagStart: number | null = null;
  let flagBiasSum = 0, flagBiasCount = 0;
  for (const p of detected) {
    const signedC = centsFromNearestNote(p.frequency!);
    const cents = Math.abs(signedC);
    if (cents <= 25) {
      if (flagStart !== null) {
        if (p.timestamp - flagStart > 0.1) {
          const avgBias = flagBiasCount > 0 ? flagBiasSum / flagBiasCount : 0;
          const dir = avgBias < -5 ? 'flat' : avgBias > 5 ? 'sharp' : 'off';
          flagged.push({ startSeconds: flagStart, endSeconds: p.timestamp, note: `Pitch ${dir} (~${Math.round(Math.abs(avgBias))}¢)` });
        }
        flagStart = null; flagBiasSum = 0; flagBiasCount = 0;
      }
    } else {
      if (flagStart === null) flagStart = p.timestamp;
      flagBiasSum += signedC; flagBiasCount++;
    }
  }
  if (flagStart !== null) {
    const avgBias = flagBiasCount > 0 ? flagBiasSum / flagBiasCount : 0;
    const dir = avgBias < -5 ? 'flat' : avgBias > 5 ? 'sharp' : 'off';
    flagged.push({ startSeconds: flagStart, endSeconds: duration, note: `Pitch ${dir} (~${Math.round(Math.abs(avgBias))}¢)` });
  }

  const score = clamp(Math.round(baseScore - biasPenalty));
  const occurrenceRate = Math.max(0, 1 - score / 100);
  const events: TechniqueEvent[] = flagged.slice(0, 6).map((ts) => ({ type: 'out_of_tune', startSeconds: ts.startSeconds, endSeconds: ts.endSeconds }));

  // Lead the summary with the most actionable finding
  const biasDir = meanBias < -8 ? 'flat' : meanBias > 8 ? 'sharp' : null;
  let observationSummary: string;
  if (flagged.length === 0 && !biasDir && score >= 85) {
    observationSummary = resonanceMissRate > 0.4
      ? 'Intonation is good overall, but notes that should ring against the open strings are slightly off.'
      : 'Intonation was accurate throughout the session.';
  } else if (biasDir && Math.abs(meanBias) > 10) {
    observationSummary = `Playing is consistently ${biasDir} by ~${Math.round(Math.abs(meanBias))} cents — this often points to a physical setup issue.`;
    if (worstNotes.length > 0) {
      const w = worstNotes[0];
      observationSummary += ` ${w.name} is most affected (${Math.round(Math.abs(w.mean))}¢ ${w.mean < 0 ? 'flat' : 'sharp'}).`;
    }
  } else if (worstNotes.length > 0) {
    const w = worstNotes[0];
    observationSummary = `${w.name} tends to be ${Math.round(Math.abs(w.mean))}¢ ${w.mean < 0 ? 'flat' : 'sharp'} — check finger placement and hand frame.`;
    if (resonanceMissRate > 0.5) observationSummary += ' Open-string resonance notes are also slightly off.';
  } else if (flagged.length > 0) {
    observationSummary = `${flagged.length} ${flagged.length === 1 ? 'passage was' : 'passages were'} noticeably out of tune.`;
  } else {
    observationSummary = 'Intonation was mostly accurate with minor fluctuations.';
  }

  return { key: 'pitchAccuracy', score, flaggedTimestamps: flagged.slice(0, 6), severity: severityFromScore(score), events, occurrenceRate, observationSummary };
}

// scoreIntonationStability now lives in ./pitchContour (pure, unit-testable).
// estimateF0HPS / sumHarmonicPower now live in ./dsp.
// scoreToneQuality now lives in ./toneAnalysis (multi-feature acoustic model).

function scoreBowSmoothness(rms: Float32Array, hopSize: number, sampleRate: number): MetricScore {
  if (rms.length < 4) {
    return { key: 'bowSmoothness', score: 70, flaggedTimestamps: [], severity: severityFromScore(70), events: [], occurrenceRate: 0, observationSummary: 'Insufficient audio to assess bow smoothness.' };
  }

  const hopS = hopSize / sampleRate;

  // --- 1. Abrupt amplitude spike detection (bow bumps at reversals) ---
  // Original logic: a sudden jump after a stable window = crunch.
  // Lowered threshold slightly from 0.12 → 0.10 for better sensitivity.
  const flagged: FlaggedTimestamp[] = [];
  let abrupt = 0;
  for (let i = 2; i < rms.length; i++) {
    const change = Math.abs(rms[i] - rms[i - 1]);
    if (change > 0.10 && Math.abs(rms[i - 1] - rms[i - 2]) <= 0.10) {
      abrupt++;
      const t = i * hopS;
      if (flagged.length < 5)
        flagged.push({ startSeconds: Math.max(0, t - 0.05), endSeconds: t + 0.12, note: 'Abrupt bow change' });
    }
  }

  // --- 2. Bow-arm tremor: amplitude oscillation at 2–6 Hz ---
  // Bow arm tension manifests as rapid RMS fluctuation (not a single spike, but a sustained wobble).
  // Measure local high-frequency variance of RMS relative to its slow mean.
  // At 20ms hop, 2–6 Hz oscillation has period 3–8 frames — captured by a ±15-frame local window.
  const TREMOR_WIN = 15; // ±15 frames = ±300ms slow envelope
  let tremorEnergy = 0;
  let playingFrames = 0;
  for (let i = TREMOR_WIN; i < rms.length - TREMOR_WIN; i++) {
    if (rms[i] < 0.02) continue; // skip silence
    playingFrames++;
    let localSum = 0;
    for (let j = i - TREMOR_WIN; j <= i + TREMOR_WIN; j++) localSum += rms[j];
    const localMean = localSum / (2 * TREMOR_WIN + 1);
    tremorEnergy += (rms[i] - localMean) ** 2;
  }
  const avgTremorVar = playingFrames > 0 ? tremorEnergy / playingFrames : 0;
  // Calibrated: avgTremorVar ~0.004 = perceptible bow arm tension; 0.008+ = clearly audible wobble
  const tremorScore = clamp(Math.round((1 - Math.min(avgTremorVar / 0.005, 1)) * 100));
  const hasTremor = avgTremorVar > 0.003;

  // --- Combine: bump penalty (55%) + tremor score (45%) ---
  const bumpScore = clamp(Math.round(100 - (abrupt / Math.max(rms.length, 1)) * 400));
  const score = clamp(Math.round(0.55 * bumpScore + 0.45 * tremorScore));
  const occurrenceRate = Math.min(1, abrupt / Math.max(rms.length / 20, 1));
  const events: TechniqueEvent[] = flagged.map((ts) => ({ type: 'abrupt_bow_change', startSeconds: ts.startSeconds, endSeconds: ts.endSeconds }));

  const observationSummary =
    abrupt === 0 && !hasTremor
      ? 'Bow strokes were smooth throughout.'
      : hasTremor && abrupt === 0
      ? 'Bow arm tension detected — volume wobbled slightly throughout. Focus on releasing shoulder and elbow tension.'
      : abrupt > 0 && !hasTremor
      ? `${abrupt} abrupt bow change${abrupt === 1 ? '' : 's'} — practice slow bow reversals at the frog and tip.`
      : `${abrupt} abrupt bow change${abrupt === 1 ? '' : 's'} plus bow arm tension — work on relaxed, continuous bow strokes.`;

  return { key: 'bowSmoothness', score, flaggedTimestamps: flagged, severity: severityFromScore(score), events, occurrenceRate, observationSummary };
}

function scoreRhythmAccuracy(onsets: number[]): { metric: MetricScore; analysis: RhythmAnalysis } {
  const emptyAnalysis = (bpmEst = 0, isRubato = false, ioiCv?: number): RhythmAnalysis => ({
    bpmEst, beatPeriodSeconds: bpmEst > 0 ? 60 / bpmEst : 0,
    tendency: null, gridScore: 0, tempoDriftScore: 100,
    rushCount: 0, dragCount: 0, onGridCount: 0, totalNotes: 0,
    localBeatPeriods: [], localBeatTimestamps: [], flaggedRegions: [],
    isRubato, ioiCv,
  });

  if (onsets.length < 6) {
    return {
      metric: { key: 'rhythmAccuracy', score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0, observationSummary: 'Too few distinct notes detected to assess tempo consistency.' },
      analysis: emptyAnalysis(),
    };
  }

  const iois: number[] = [];
  for (let i = 1; i < onsets.length; i++) iois.push(onsets[i] - onsets[i - 1]);

  // Rubato/noise guard: compute CV on trimmed IOIs only.
  // Raw CV over all IOIs is unreliable — phrase-end pauses (2–4× normal IOI) and
  // any spurious short onsets inflate it far above 0.55 even for steady playing.
  // Trim to IOIs within [median/3, median*4] before measuring variance.
  const sortedIois = [...iois].sort((a, b) => a - b);
  const ioiMedian = sortedIois[Math.floor(sortedIois.length / 2)];
  const trimmedIois = iois.filter(v => v >= ioiMedian / 3 && v <= ioiMedian * 4);
  const ioiMeanTrimmed = trimmedIois.length > 0
    ? trimmedIois.reduce((a, b) => a + b, 0) / trimmedIois.length
    : 0;
  const ioiCv = trimmedIois.length > 1
    ? Math.sqrt(trimmedIois.reduce((a, v) => a + (v - ioiMeanTrimmed) ** 2, 0) / trimmedIois.length) / (ioiMeanTrimmed + 1e-6)
    : 0;
  if (ioiCv > 0.70) {
    return {
      metric: { key: 'rhythmAccuracy', score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0,
        observationSummary: 'Tempo varied significantly throughout — if you were playing expressively (ritardando, rubato), that explains the variation. This metric works best with steady, metronomic playing.' },
      analysis: emptyAnalysis(0, true, ioiCv),
    };
  }

  // --- 1. Extract dominant beat period via IOI histogram ---
  // The old CV-of-all-IOIs approach penalizes intentional rhythmic variety (dotted rhythms,
  // triplets, mixed values) because it assumes all notes should be equally spaced.
  // A histogram approach finds the actual beat unit the student is using.
  const BIN_MS    = 20;   // 20ms resolution
  const MIN_MS    = 50;   // 50ms = 16th note at ~300 BPM (upper limit)
  const MAX_MS    = 2000; // 2s = half note at 60 BPM (lower limit)
  const NUM_BINS  = Math.ceil((MAX_MS - MIN_MS) / BIN_MS);
  const histogram = new Float32Array(NUM_BINS);
  for (const ioi of iois) {
    const bin = Math.floor((ioi * 1000 - MIN_MS) / BIN_MS);
    if (bin >= 0 && bin < NUM_BINS) histogram[bin]++;
  }
  // 3-bin Gaussian-ish smooth to remove aliasing
  const smoothHist = new Float32Array(NUM_BINS);
  for (let i = 0; i < NUM_BINS; i++) {
    smoothHist[i] = (
      (histogram[Math.max(0, i - 1)] * 0.25) +
      (histogram[i] * 0.50) +
      (histogram[Math.min(NUM_BINS - 1, i + 1)] * 0.25)
    );
  }
  let peakBin = 0;
  for (let i = 1; i < NUM_BINS; i++) if (smoothHist[i] > smoothHist[peakBin]) peakBin = i;
  const beatPeriod = (peakBin * BIN_MS + MIN_MS) / 1000; // seconds
  const bpmEst = Math.round(60 / beatPeriod);
  if (bpmEst < 30 || bpmEst > 280) {
    return {
      metric: { key: 'rhythmAccuracy', score: 65, flaggedTimestamps: [], severity: severityFromScore(65), events: [], occurrenceRate: 0,
        observationSummary: 'Could not identify a clear pulse — too few distinct note changes detected for tempo analysis.' },
      analysis: emptyAnalysis(),
    };
  }

  // --- 2. Grid alignment: each IOI should be near an integer multiple of the beat ---
  // Tolerance = ±12% of beatPeriod × multiplier (looser for longer notes)
  const GRID_TOLERANCE = 0.12;
  let onGridCount = 0;
  let rushCount = 0, dragCount = 0;
  const rhythmFlagged: FlaggedTimestamp[] = [];
  const flaggedRegions: RhythmFlaggedRegion[] = [];
  for (let i = 0; i < iois.length; i++) {
    const ioi = iois[i];
    const ratio = ioi / beatPeriod;
    const nearestInt = Math.max(1, Math.round(ratio));
    const expected = nearestInt * beatPeriod;
    const deviation = Math.abs(ioi - expected) / expected;
    if (deviation <= GRID_TOLERANCE) {
      onGridCount++;
    } else {
      const isRush = ioi < expected;
      if (isRush) rushCount++; else dragCount++;
      if (flaggedRegions.length < 6) {
        const deviationPct = Math.round(deviation * 100);
        const direction = isRush ? 'rushed' : 'dragged' as const;
        const label = isRush ? `Rushed (${deviationPct}% short)` : `Dragged (${deviationPct}% long)`;
        flaggedRegions.push({
          startSeconds: onsets[i],
          endSeconds: onsets[i + 1] ?? onsets[i] + ioi,
          direction,
          deviationPct,
          label,
        });
        rhythmFlagged.push({
          startSeconds: onsets[i],
          endSeconds: onsets[i + 1] ?? onsets[i] + ioi,
          note: label,
        });
      }
    }
  }
  const gridScore = clamp(Math.round((onGridCount / iois.length) * 100));

  // --- 3. Tempo consistency: does the beat drift over the session? ---
  const WIN = Math.max(2, Math.min(5, Math.floor(iois.length / 3)));
  const localBeatPeriods: number[] = [];
  const localBeatTimestamps: number[] = [];
  for (let i = WIN; i + WIN < iois.length; i++) {
    let sum = 0;
    for (let j = i - WIN; j <= i + WIN; j++) sum += iois[j];
    localBeatPeriods.push(sum / (2 * WIN + 1));
    localBeatTimestamps.push(onsets[i + 1]);
  }
  let tempoDriftScore = 100;
  if (localBeatPeriods.length >= 3) {
    const tmean = localBeatPeriods.reduce((a, b) => a + b, 0) / localBeatPeriods.length;
    const tdrift = Math.sqrt(localBeatPeriods.reduce((acc, b) => acc + (b - tmean) ** 2, 0) / localBeatPeriods.length);
    tempoDriftScore = clamp(Math.round((1 - Math.min(tdrift / beatPeriod / 0.15, 1)) * 100));
  }

  const score = clamp(Math.round(0.60 * gridScore + 0.40 * tempoDriftScore));
  const occurrenceRate = 1 - onGridCount / iois.length;
  const tendency = rushCount > dragCount * 1.5 ? 'rushing' : dragCount > rushCount * 1.5 ? 'dragging' : null;

  const observationSummary =
    score >= 85
      ? `Tempo was steady throughout (~${bpmEst} BPM).`
      : gridScore < 60 && tendency
      ? `Tempo was unsteady — tendency toward ${tendency} at ~${bpmEst} BPM. Practice with a metronome and focus on even note durations.`
      : gridScore < 60
      ? `Tempo was unsteady — notes didn't align to a consistent pulse (~${bpmEst} BPM). Try practicing with a metronome.`
      : tempoDriftScore < 60
      ? `Tempo drifted noticeably over the session (~${bpmEst} BPM). Try locking to a metronome from start to finish.`
      : tendency
      ? `Some ${tendency} detected at ~${bpmEst} BPM — focus on counting subdivisions internally.`
      : `Slight tempo unevenness at ~${bpmEst} BPM — keep working on consistent note durations.`;

  return {
    metric: { key: 'rhythmAccuracy', score, flaggedTimestamps: rhythmFlagged, severity: severityFromScore(score), events: [], occurrenceRate, observationSummary },
    analysis: {
      bpmEst,
      beatPeriodSeconds: beatPeriod,
      tendency,
      gridScore,
      tempoDriftScore,
      rushCount,
      dragCount,
      onGridCount,
      totalNotes: iois.length,
      localBeatPeriods,
      localBeatTimestamps,
      flaggedRegions,
      isRubato: false,
      ioiCv,
    },
  };
}

function scoreDynamicControl(rms: Float32Array, hopSize: number, sampleRate: number, pitchFrames?: PitchFrame[]): MetricScore {
  const hopS = hopSize / sampleRate;

  const insufficient = (msg: string): MetricScore => ({
    key: 'dynamicControl', score: 70, flaggedTimestamps: [], severity: severityFromScore(70),
    events: [], occurrenceRate: 0, observationSummary: msg,
  });
  if (rms.length < 10) return insufficient('Insufficient audio to assess dynamics.');
  const playing = Array.from(rms).filter(v => v > 0.015);
  if (playing.length < 10) return insufficient('Insufficient non-silent audio to assess dynamics.');

  // ─── 1. Bow jitter score (unchanged) ────────────────────────────────────
  const globalMeanRms = playing.reduce((a, b) => a + b, 0) / playing.length;
  const hw = 10;
  let fastVar = 0;
  for (let i = 0; i < rms.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - hw); j <= Math.min(rms.length - 1, i + hw); j++) { sum += rms[j]; cnt++; }
    fastVar += (rms[i] - sum / cnt) ** 2;
  }
  fastVar /= rms.length;
  const jitterNorm = fastVar / (globalMeanRms * globalMeanRms * 0.15 + 1e-10);
  const jitterScore = clamp(Math.round((1 - Math.min(jitterNorm, 1)) * 100));

  // ─── 2. 250ms smoothed envelope ─────────────────────────────────────────
  const SLOW_WIN = Math.max(1, Math.round(0.25 / hopS));
  const slowRms = new Float32Array(rms.length);
  for (let i = 0; i < rms.length; i++) {
    let sum = 0, cnt = 0;
    for (let j = Math.max(0, i - SLOW_WIN); j <= Math.min(rms.length - 1, i + SLOW_WIN); j++) { sum += rms[j]; cnt++; }
    slowRms[i] = sum / cnt;
  }
  const slowPlaying = Array.from(slowRms).filter(v => v > 0.015);
  const maxSlow = Math.max(...slowPlaying);
  const minSlow = Math.min(...slowPlaying);
  const dynamicRatio = maxSlow / Math.max(minSlow, 0.001);
  const rangeScore = clamp(Math.round(((dynamicRatio - 1.3) / (4.0 - 1.3)) * 100));

  // ─── 3. Phrase shape score (unchanged) ──────────────────────────────────
  const WIN_FRAMES = Math.max(4, Math.round(2.0 / hopS));
  let r2Sum = 0, r2Count = 0;
  for (let i = 0; i + WIN_FRAMES < slowRms.length; i += Math.max(1, Math.floor(WIN_FRAMES / 2))) {
    const windowActive = Array.from(slowRms).slice(i, i + WIN_FRAMES).filter(v => v > 0.015);
    if (windowActive.length < WIN_FRAMES * 0.6) continue;
    const n = WIN_FRAMES;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let j = 0; j < n; j++) { sx += j; sy += slowRms[i + j]; sxy += j * slowRms[i + j]; sx2 += j * j; }
    const denom = n * sx2 - sx * sx;
    if (denom === 0) continue;
    const slope = (n * sxy - sx * sy) / denom;
    const intercept = (sy - slope * sx) / n;
    let ssRes = 0, ssTot = 0;
    const yMean = sy / n;
    for (let j = 0; j < n; j++) {
      ssRes += (slowRms[i + j] - (slope * j + intercept)) ** 2;
      ssTot += (slowRms[i + j] - yMean) ** 2;
    }
    if (ssTot > 1e-10) { r2Sum += 1 - ssRes / ssTot; r2Count++; }
  }
  const shapeScore = clamp(Math.round((r2Count > 0 ? r2Sum / r2Count : 0.5) * 100));
  const score = clamp(Math.round(0.30 * jitterScore + 0.35 * rangeScore + 0.35 * shapeScore));
  const occurrenceRate = 1 - score / 100;

  // ─── 4. Phrase segmentation (for event detection) ───────────────────────
  // Tune these constants against real recordings — all keyed to hopS so they
  // stay correct regardless of hop size.
  const SILENCE_GATE   = 0.015;
  const SILENCE_FRAMES = Math.max(10, Math.round(0.30 / hopS)); // 300ms gap = phrase break
  const MIN_PH_FRAMES  = Math.max(30, Math.round(3.0  / hopS)); // skip phrases < 3s
  const FLAT_CV2       = 0.004;  // stricter: only truly monotone phrases flagged
  const INV_SLOPE_NORM = -0.20;  // normalized slope threshold for falling classification
  const RISING_SLOPE   = 0.15;   // normalized slope threshold for rising classification
  const PEAK_EARLY     = 0.15;   // tightened: sforzando-like attack (28% was too aggressive)
  const PEAK_LATE      = 0.82;   // peak in last 18% with positive slope = late swell
  const CONSEC_FALLING = 3;      // flag dyn_inverted only after this many consecutive falling phrases
  const MAX_EVENTS     = 5;

  const phrases: { start: number; end: number }[] = [];
  let inPhrase = false, pStart = 0, silCnt = 0;
  for (let i = 0; i <= rms.length; i++) {
    const active = i < rms.length && rms[i] > SILENCE_GATE;
    if (active) {
      if (!inPhrase) { inPhrase = true; pStart = i; }
      silCnt = 0;
    } else if (inPhrase) {
      silCnt++;
      if (silCnt >= SILENCE_FRAMES || i === rms.length) {
        const pEnd = i === rms.length ? i - 1 : i - silCnt;
        if (pEnd - pStart >= MIN_PH_FRAMES) phrases.push({ start: pStart, end: pEnd });
        inPhrase = false; silCnt = 0;
      }
    }
  }

  // ─── 5. Shape classifier ─────────────────────────────────────────────────
  // Classifies each phrase into a musical shape before deciding whether to flag.
  // Rising and falling are both valid choices — only truly shapeless or
  // unexpectedly-shaped phrases get flagged.
  function classifyPhraseShape(cv2: number, slopeNorm: number, peakPos: number): PhraseShape {
    if (cv2 < FLAT_CV2) return 'plateau';
    if (slopeNorm >= RISING_SLOPE && peakPos > 0.55) return 'rising';
    if (slopeNorm <= INV_SLOPE_NORM && peakPos < 0.45) return 'falling';
    if (peakPos >= 0.20 && peakPos <= 0.80) return 'arch';
    return 'unclassified';
  }

  // Compute linear slope of pitch (cents) over a phrase for melodic contour correlation.
  // Returns positive if pitch trends up, negative if pitch trends down, null if no data.
  function phrasePitchSlope(startSec: number, endSec: number): number | null {
    if (!pitchFrames) return null;
    const frames = pitchFrames.filter(p => p.frequency !== null && p.timestamp >= startSec && p.timestamp <= endSec);
    if (frames.length < 4) return null;
    const cents = frames.map(p => 1200 * Math.log2(p.frequency! / 440));
    const n = cents.length;
    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let j = 0; j < n; j++) { sx += j; sy += cents[j]; sxy += j * cents[j]; sx2 += j * j; }
    const den = n * sx2 - sx * sx;
    return den !== 0 ? (n * sxy - sx * sy) / den : null;
  }

  // ─── 6. Issue detection ──────────────────────────────────────────────────
  interface DynIssue { type: string; startSec: number; endSec: number; note: string; confidence: number; }
  const issues: DynIssue[] = [];
  const fmtT = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

  // Per-phrase debug rows — populated inside the phrase loop below
  const phraseDebugRows: DynPhraseDebug[] = [];

  // A3: Narrow dynamic range (objective — never suppressed)
  if (dynamicRatio < 2.5) {
    const conf = 1 - Math.max(0, dynamicRatio - 1.0) / (2.5 - 1.0);
    const r = dynamicRatio.toFixed(1);
    issues.push({
      type: 'dyn_narrow_range', startSec: 0, endSec: rms.length * hopS, confidence: conf,
      note: dynamicRatio < 2.0
        ? `Dynamic range is very narrow (${r}× contrast) — try using a full, heavy bow for forte and a light touch for piano. Aim for 5× or more.`
        : `Dynamic range is limited (${r}× contrast) — push the contrast between your softest and loudest moments.`,
    });
  }

  // B-types: per-phrase shape analysis
  const flatPhrases: { startSec: number; endSec: number }[] = [];
  let consecutiveFalling = 0;
  let fallingRunStart = -1;

  for (const phrase of phrases) {
    const arr = Array.from(slowRms).slice(phrase.start, phrase.end + 1);
    const n = arr.length;
    if (n < 4) continue;

    const mean = arr.reduce((a, b) => a + b, 0) / n;
    const variance = arr.reduce((a, v) => a + (v - mean) ** 2, 0) / n;
    const cv2 = variance / (mean * mean + 1e-10);

    const pMax = Math.max(...arr);
    const pMin = Math.min(...arr);
    const range = pMax - pMin;

    let sx = 0, sy = 0, sxy = 0, sx2 = 0;
    for (let j = 0; j < n; j++) { sx += j; sy += arr[j]; sxy += j * arr[j]; sx2 += j * j; }
    const den = n * sx2 - sx * sx;
    const rawSlope = den !== 0 ? (n * sxy - sx * sy) / den : 0;
    const slopeNorm = rawSlope * n / (range + 1e-8);

    let peakIdx = 0;
    for (let j = 1; j < n; j++) { if (arr[j] > arr[peakIdx]) peakIdx = j; }
    const peakPos = peakIdx / (n - 1);

    const startSec = phrase.start * hopS;
    const endSec   = phrase.end   * hopS;

    // Classify shape, then apply melodic-contour correction
    let shape = classifyPhraseShape(cv2, slopeNorm, peakPos);

    // If both RMS and pitch trend in the same direction, it's melodic contour — no flag
    const pitchSlope = phrasePitchSlope(startSec, endSec);
    if (pitchSlope !== null && shape !== 'plateau') {
      const rmsDir = rawSlope > 0 ? 1 : rawSlope < 0 ? -1 : 0;
      const pitchDir = pitchSlope > 50 ? 1 : pitchSlope < -50 ? -1 : 0; // >50 cents/frame = clear trend
      if (rmsDir !== 0 && rmsDir === pitchDir) shape = 'melodic_contour';
    }

    // Reset or advance the consecutive-falling counter
    if (shape === 'falling') {
      consecutiveFalling++;
      if (consecutiveFalling === 1) fallingRunStart = startSec;
    } else {
      consecutiveFalling = 0;
      fallingRunStart = -1;
    }

    // Issue rules by shape
    if (shape === 'plateau') {
      // Flat — flag it
      phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape, issue: 'dyn_flat_phrase', confidence: 0.40 + 0.1 * flatPhrases.length });
      flatPhrases.push({ startSec, endSec });

    } else if (shape === 'falling') {
      // Single falling phrase → valid diminuendo, no flag; 3+ in a row → flag the run
      const debugIssue = consecutiveFalling >= CONSEC_FALLING ? 'dyn_inverted_phrase' : undefined;
      phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape, issue: debugIssue });
      if (consecutiveFalling === CONSEC_FALLING) {
        const conf = Math.min(1, 0.50 + (consecutiveFalling - CONSEC_FALLING) * 0.15);
        issues.push({
          type: 'dyn_inverted_phrase',
          startSec: fallingRunStart,
          endSec,
          confidence: conf,
          note: `${consecutiveFalling} phrases in a row are fading out — at ${fmtT(fallingRunStart)}, try letting at least one phrase build or hold steady.`,
        });
      }

    } else if (shape === 'rising' || shape === 'arch' || shape === 'melodic_contour') {
      // All valid — never flag shape issues
      phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape });

    } else {
      // unclassified — apply tightened peak thresholds
      if (peakPos < PEAK_EARLY) {
        const conf = Math.min(1, (PEAK_EARLY - peakPos) / PEAK_EARLY * 1.5);
        if (conf >= 0.3) {
          const peakSec = (phrase.start + peakIdx) * hopS;
          phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape, issue: 'dyn_peak_early', confidence: conf });
          issues.push({
            type: 'dyn_peak_early', startSec, endSec, confidence: conf,
            note: `At ${fmtT(startSec)}, you peaked at ${fmtT(peakSec)} — very early in the phrase. Save the climax for later.`,
          });
        } else {
          phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape });
        }
      } else if (peakPos > PEAK_LATE && slopeNorm > 0.1) {
        const conf = Math.min(1, (peakPos - PEAK_LATE) / (1 - PEAK_LATE) * 1.5);
        if (conf >= 0.3) {
          phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape, issue: 'dyn_peak_late', confidence: conf });
          issues.push({
            type: 'dyn_peak_late', startSec, endSec, confidence: conf,
            note: `At ${fmtT(startSec)}, volume keeps building right to the end of the phrase at ${fmtT(endSec)} — try leveling off earlier.`,
          });
        } else {
          phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape });
        }
      } else {
        phraseDebugRows.push({ startSec, endSec, durS: endSec - startSec, cv2, slopeNorm, peakPos, shape });
      }
    }
  }

  // Aggregate flat phrases into events
  if (flatPhrases.length >= 3) {
    issues.push({
      type: 'dyn_flat_phrases',
      startSec: flatPhrases[0].startSec,
      endSec:   flatPhrases[flatPhrases.length - 1].endSec,
      confidence: Math.min(1, flatPhrases.length / 4),
      note: `${flatPhrases.length} phrases in a row sound flat in volume — try adding shape to each phrase: build toward a peak or taper at the end.`,
    });
  } else {
    for (const fp of flatPhrases) {
      issues.push({
        type: 'dyn_flat_phrase', startSec: fp.startSec, endSec: fp.endSec,
        confidence: 0.40 + 0.1 * flatPhrases.length,
        note: `The phrase at ${fmtT(fp.startSec)}–${fmtT(fp.endSec)} sounds flat in volume — add shape by building toward a peak or tapering at the end.`,
      });
    }
  }

  // D2: Session-wide volume fade (linear regression over phrase means)
  if (phrases.length >= 4) {
    const phraseMeans = phrases.map(p => {
      const sl = Array.from(slowRms).slice(p.start, p.end + 1).filter(v => v > SILENCE_GATE);
      return sl.length > 0 ? sl.reduce((a, b) => a + b, 0) / sl.length : 0;
    });
    const pn = phraseMeans.length;
    let px = 0, py = 0, pxy = 0, px2 = 0;
    for (let i = 0; i < pn; i++) { px += i; py += phraseMeans[i]; pxy += i * phraseMeans[i]; px2 += i * i; }
    const pDen = pn * px2 - px * px;
    if (pDen !== 0) {
      const pSlope = (pn * pxy - px * py) / pDen;
      const normSlope = pSlope / (py / pn + 1e-10);
      if (normSlope < -0.04) {
        issues.push({
          type: 'dyn_fade_over_session', startSec: 0, endSec: rms.length * hopS,
          confidence: Math.min(1, Math.abs(normSlope) / 0.08),
          note: 'Your volume gradually fades over the session — stay physically engaged and keep bow arm energy in the second half.',
        });
      }
    }
  }

  // ─── 6. Rank, filter, cap ────────────────────────────────────────────────
  const allIssuesBeforeFilter = [...issues];
  const ranked = issues
    .filter(e => e.confidence >= 0.30)
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_EVENTS);

  // ─── 7. Specific observationSummary from top issue ───────────────────────
  const observationSummary = ranked.length > 0
    ? ranked[0].note
    : score >= 78
      ? 'Good dynamic control — clear and deliberate volume shaping throughout.'
      : jitterScore < 50
        ? 'Bow arm tension is causing erratic volume — focus on a smooth, relaxed bow stroke.'
        : 'Dynamics were relatively flat — work on deliberate phrase arcs (louder at the peak, softer at the end).';

  // ─── 8. timeSeries: normalized slow envelope for waveform rendering ──────
  const sessionMax = Math.max(...Array.from(rms));
  const timeSeries = Array.from(slowRms).map((v, i) => ({
    t: i * hopS,
    v: Math.min(1, v / (sessionMax + 1e-10)),
  }));

  // ─── 9. Debug payload ────────────────────────────────────────────────────
  const _dynDebug: DynDebugInfo = {
    dynamicRatio, maxSlow, minSlow, jitterScore, rangeScore, shapeScore, score,
    phrases: phraseDebugRows,
    allIssues: allIssuesBeforeFilter.map(e => ({ type: e.type, startSec: e.startSec, endSec: e.endSec, confidence: e.confidence, note: e.note })),
    ranked: ranked.map(e => ({ type: e.type, confidence: e.confidence })),
  };

  if (__DEV__) {
    const fmtN = (n: number, d = 3) => n.toFixed(d);
    console.log(
      `\n[DYN DEBUG] ratio=${fmtN(dynamicRatio, 2)}× max=${fmtN(maxSlow)} min=${fmtN(minSlow)}` +
      `  jitter=${jitterScore} range=${rangeScore} shape=${shapeScore} → score=${score}` +
      `  thresholds: FLAT_CV2=${FLAT_CV2} INV_SLOPE=${INV_SLOPE_NORM} PEAK_E=${PEAK_EARLY} PEAK_L=${PEAK_LATE}\n` +
      `  Phrases (${phraseDebugRows.length}):\n` +
      phraseDebugRows.map((p, i) =>
        `    #${i + 1}  ${fmtT(p.startSec)}–${fmtT(p.endSec)}  ${fmtN(p.durS, 1)}s` +
        `  cv²=${fmtN(p.cv2)}  slope=${fmtN(p.slopeNorm)}  peak@${fmtN(p.peakPos)}  [${p.shape}]` +
        (p.issue ? `  → ${p.issue} (conf=${fmtN(p.confidence ?? 0)})` : '  → ok')
      ).join('\n') +
      `\n  All issues (${allIssuesBeforeFilter.length}):\n` +
      allIssuesBeforeFilter.map(e => `    ${e.type}  ${fmtT(e.startSec)}  conf=${fmtN(e.confidence)}`).join('\n') +
      `\n  Ranked output (${ranked.length}): ${ranked.map(e => e.type).join(', ') || 'none'}\n`
    );
  }

  return {
    key: 'dynamicControl',
    score,
    flaggedTimestamps: ranked.map(e => ({ startSeconds: e.startSec, endSeconds: e.endSec, note: e.note })),
    severity: severityFromScore(score),
    events: ranked.map(e => ({ type: e.type, startSeconds: e.startSec, endSeconds: e.endSec })),
    occurrenceRate,
    observationSummary,
    timeSeries,
    _dynDebug,
  };
}

/**
 * Splits detected pitch frames into per-note segments using onset timestamps as boundaries.
 * Each onset marks the start of a new note; frames before the first onset go into note 0.
 * Falls back to the full detected array as one segment if no onsets are available.
 */
function segmentPitchesByOnsets(detected: PitchFrame[], onsets: number[]): PitchFrame[][] {
  if (onsets.length === 0) return [detected];
  const boundaries = [...onsets, Infinity];
  const segments: PitchFrame[][] = [];
  let seg: PitchFrame[] = [];
  let bIdx = 0;
  for (const frame of detected) {
    while (bIdx < boundaries.length - 2 && frame.timestamp >= boundaries[bIdx + 1]) {
      if (seg.length > 0) segments.push(seg);
      seg = [];
      bIdx++;
    }
    seg.push(frame);
  }
  if (seg.length > 0) segments.push(seg);
  return segments;
}

// classifyVibratoSegment now lives in ./pitchContour (pure, unit-testable).

function scoreVibrato(pitches: PitchFrame[], onsets?: number[]): { metric: MetricScore; analysis: VibratoAnalysis } {
  const detected = pitches.filter((p) => p.frequency !== null);
  const audioDuration = detected.length > 0 ? detected[detected.length - 1].timestamp : 0;
  const emptyAnalysis: VibratoAnalysis = { eligibleCount: 0, avgNoteScore: 0, notes: [] };

  if (detected.length < 20) {
    return { metric: { key: 'vibrato', score: 50, flaggedTimestamps: [], severity: severityFromScore(50), events: [], occurrenceRate: 0.5, observationSummary: 'Insufficient sustained notes to assess vibrato.' }, analysis: emptyAnalysis };
  }

  type SegWithBounds = { frames: PitchFrame[]; startS: number; endS: number };
  let allSegs: SegWithBounds[];
  if (onsets && onsets.length > 0) {
    allSegs = onsets.map((startS, i) => {
      const endS = onsets[i + 1] ?? audioDuration;
      return { startS, endS, frames: detected.filter((f) => f.timestamp >= startS && f.timestamp < endS) };
    });
  } else {
    const rawSegs: PitchFrame[][] = [];
    let current: PitchFrame[] = [detected[0]];
    for (let i = 1; i < detected.length; i++) {
      const prev = detected[i - 1];
      const curr = detected[i];
      const centsDiff = Math.abs(1200 * Math.log2(curr.frequency! / prev.frequency!));
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

  if (eligible.length === 0) {
    return { metric: { key: 'vibrato', score: 50, flaggedTimestamps: [], severity: severityFromScore(50), events: [], occurrenceRate: 0.5, observationSummary: 'No sustained notes long enough to detect vibrato.' }, analysis: emptyAnalysis };
  }

  const segResults = eligible.map((seg) => {
    const freqs = seg.frames.map((f) => f.frequency!);
    const sorted = [...freqs].sort((a, b) => a - b);
    const medianFreq = sorted[Math.floor(sorted.length / 2)];
    // Octave-correct each frame before computing cents deviation.
    // YIN sometimes returns a frequency an octave too high or too low; without this,
    // a single octave-flipped frame contributes ±1200¢ to the variance and destroys
    // the depth and autocorrelation calculations.
    const corrected = freqs.map((f) => {
      const dist = Math.abs(1200 * Math.log2(f / medianFreq));
      if (dist <= 600) return f;
      const halfDist  = Math.abs(1200 * Math.log2((f / 2) / medianFreq));
      const doubleDist = Math.abs(1200 * Math.log2((f * 2) / medianFreq));
      if (halfDist < dist && halfDist <= doubleDist) return f / 2;
      if (doubleDist < dist) return f * 2;
      return f;
    });
    const devs = corrected.map((f) => 1200 * Math.log2(f / medianFreq));
    return { seg, devs, result: classifyVibratoSegment(devs, 40) };
  });

  // Duration-weighted average so long sustained notes count more than brief ones
  const totalDuration = segResults.reduce((a, r) => a + (r.seg.endS - r.seg.startS), 0);
  const avgScore = clamp(Math.round(
    segResults.reduce((a, r) => a + r.result.noteScore * (r.seg.endS - r.seg.startS), 0) / totalDuration,
  ));

  // Collect feedback ranked by how often each message appears across segments, cap at 3
  const EXCLUDED_FEEDBACK = new Set(['no vibrato detected', 'vibrato rhythm is too uneven to measure — try for a steadier wrist motion']);
  const feedbackCounts = new Map<string, number>();
  for (const r of segResults) {
    for (const msg of r.result.feedbackNotes) {
      if (!EXCLUDED_FEEDBACK.has(msg)) feedbackCounts.set(msg, (feedbackCounts.get(msg) ?? 0) + 1);
    }
  }
  const uniqueFeedback = [...feedbackCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([msg]) => msg);

  const occurrenceRate = Math.max(0, 1 - avgScore / 100);
  const observationSummary =
    avgScore >= 70 ? 'Vibrato is well-controlled and musical.' :
    avgScore >= 45 ? `Vibrato is present with some areas to refine. ${uniqueFeedback[0] ?? ''}` :
    avgScore >= 20 ? `Vibrato is inconsistent — keep working on evenness and depth. ${uniqueFeedback.slice(0, 2).join(' ')}` :
    'Vibrato mostly absent — try introducing a regular wrist motion.';

  const vibratoNotes: VibratoNoteResult[] = segResults.map(({ seg, devs, result }) => ({
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
  }));

  return {
    metric: { key: 'vibrato', score: avgScore, flaggedTimestamps: [], severity: severityFromScore(avgScore), events: [], occurrenceRate, observationSummary },
    analysis: { eligibleCount: eligible.length, avgNoteScore: avgScore, notes: vibratoNotes },
  };
}

// ─────────────────────────────────────────────────────────────
// Raw signal extraction for note fusion and timbre analysis
// ─────────────────────────────────────────────────────────────

// Per-frame tone quality + timbre proxies in a single FFT pass.
// 2048-pt Hann-windowed FFT, 50ms hop — matches scoreToneQuality hop.
function computeTimbreFrames(
  samples: Float32Array,
  sampleRate: number,
): { fundamentalRatio: number; spectralCentroid: number; brightness: number; timestamp: number }[] {
  const fftSize = 2048;
  const hopSize = Math.round(sampleRate * 0.05); // 50ms
  const binHz = sampleRate / fftSize;
  const cutoffBin = Math.floor(3000 / binHz); // brightness: energy above 3 kHz
  const frames: { fundamentalRatio: number; spectralCentroid: number; brightness: number; timestamp: number }[] = [];

  for (let offset = 0; offset + fftSize < samples.length; offset += hopSize) {
    const mag = magnitudeSpectrum(samples, offset, fftSize);
    let maxMag = 0, maxBin = 1, totalPow = 0, weightedSum = 0, highPow = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      weightedSum += (i * binHz) * m2;
      if (i >= cutoffBin) highPow += m2;
      if (mag[i] > maxMag) { maxMag = mag[i]; maxBin = i; }
    }
    const isSilent = maxMag < 0.002;
    frames.push({
      fundamentalRatio:  isSilent ? 0 : (mag[maxBin] * mag[maxBin]) / (totalPow + 1e-10),
      spectralCentroid:  isSilent || totalPow < 1e-10 ? 0 : weightedSum / totalPow,
      brightness:        isSilent || totalPow < 1e-10 ? 0 : highPow / totalPow,
      timestamp: offset / sampleRate,
    });
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
  rhythmAccuracy: { onsetCount: number; meanIoi: number; cvIoi: number; fluxOnsets: number; pitchOnsets: number };
  dynamicControl: { fastVar: number };
  vibrato: {
    eligibleSegments: number;
    avgNoteScore: number;
    notes: Array<{
      startS: number;
      endS: number;
      durationS: number;
      pitchFrameCount: number;
      eligible: boolean;
      rateHz: number;
      depthCents: number;
      periodicityScore: number;
      consistencyOk: boolean;
      feedbackNotes: string[];
      noteScore: number;
      cents: number[];
    }>;
  };
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
  const fluxOnsets  = computeSpectralFluxOnsets(samples, sampleRate);
  const pitchOnsets = detectPitchChangeOnsets(pitches);
  const onsets      = collapseAdjacentSameNoteOnsets(mergeOnsets(fluxOnsets, pitchOnsets), pitches, duration);

  const { metric: vibratoMetric } = scoreVibrato(pitches, onsets);
  const scores = [
    scorePitchAccuracy(pitches, duration),
    scoreIntonationStability(pitches).metric,
    scoreToneQuality(samples, sampleRate, duration, pitches),
    scoreBowSmoothness(rms, rmsHop, sampleRate),
    scoreRhythmAccuracy(onsets).metric,
    scoreDynamicControl(rms, rmsHop, sampleRate, pitches),
    vibratoMetric,
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

  // Intonation stability — reuse the single source of truth (vibrato-aware, legato-aware).
  const stabilityStats = computeIntonationStability(pitches);
  const stdCents =
    stabilityStats.mode === 'per-note' ? stabilityStats.avgStd :
    stabilityStats.mode === 'short'    ? stabilityStats.stdCents : 0;

  // Tone quality debug — mirrors HNR approach used in scoreToneQuality
  const fftSize = 2048;
  const tqHop = Math.round(sampleRate * 0.05); // 50ms, matches scoreToneQuality
  let tqGood = 0, tqTotal = 0, tqSilent = 0, tqSumRatio = 0;
  for (let offset = 0; offset + fftSize < samples.length; offset += tqHop) {
    const mag = magnitudeSpectrum(samples, offset, fftSize);
    let maxMag = 0, totalPow = 0;
    for (let i = 1; i < mag.length; i++) {
      const m2 = mag[i] * mag[i];
      totalPow += m2;
      if (mag[i] > maxMag) maxMag = mag[i];
    }
    tqTotal++;
    if (maxMag < 0.002) { tqSilent++; continue; }
    const f0 = estimateF0HPS(mag, sampleRate, fftSize);
    let hnrRatio = 0;
    if (f0 !== null) {
      const { harmonicPow } = sumHarmonicPower(mag, f0, sampleRate, fftSize, 12, 2);
      hnrRatio = harmonicPow / (totalPow + 1e-10);
    }
    tqSumRatio += hnrRatio;
    if (hnrRatio >= 0.45) tqGood++;
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

  // Vibrato — all onset-bounded note windows, including short ones
  let debugEligibleSegments = 0, debugAvgNoteScore = 0;
  const debugNotes: AudioDebugInfo['vibrato']['notes'] = [];
  if (detected.length >= 20 && onsets.length > 0) {
    const eligibleScores: number[] = [];
    for (let ni = 0; ni < onsets.length; ni++) {
      const startS = onsets[ni];
      const endS = onsets[ni + 1] ?? duration;
      const noteDur = endS - startS;
      const noteFrames = detected.filter((f) => f.timestamp >= startS && f.timestamp < endS);
      const pitchFrameCount = noteFrames.length;
      const eligible = noteDur >= VIBRATO_MIN_SEGMENT_S && pitchFrameCount >= VIBRATO_MIN_FRAMES;
      if (!eligible) {
        debugNotes.push({
          startS: Math.round(startS * 100) / 100,
          endS: Math.round(endS * 100) / 100,
          durationS: Math.round(noteDur * 100) / 100,
          pitchFrameCount,
          eligible: false,
          rateHz: 0, depthCents: 0, periodicityScore: 0,
          consistencyOk: true, feedbackNotes: [], noteScore: 0,
          cents: [],
        });
        continue;
      }
      debugEligibleSegments++;
      const freqs = noteFrames.map((f) => f.frequency!);
      const sorted = [...freqs].sort((a, b) => a - b);
      const medianFreq = sorted[Math.floor(sorted.length / 2)];
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
      eligibleScores.push(result.noteScore);
      debugNotes.push({
        startS: Math.round(startS * 100) / 100,
        endS: Math.round(endS * 100) / 100,
        durationS: Math.round(noteDur * 100) / 100,
        pitchFrameCount,
        eligible: true,
        rateHz: Math.round(result.rate * 10) / 10,
        depthCents: Math.round(result.depth * 10) / 10,
        periodicityScore: Math.round(result.periodicityScore * 100) / 100,
        consistencyOk: result.consistencyOk,
        feedbackNotes: result.feedbackNotes,
        noteScore: result.noteScore,
        cents: devs.map((c) => Math.round(c * 10) / 10),
      });
    }
    debugAvgNoteScore = eligibleScores.length > 0 ? Math.round(eligibleScores.reduce((a, b) => a + b, 0) / eligibleScores.length) : 0;
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
      avgFundamentalRatio: tqNonSilent > 0 ? tqSumRatio / tqNonSilent : 0, // now = avg HNR ratio
      goodFrameRatio: tqTotal > 0 ? tqGood / tqTotal : 0,
      silentFrameCount: tqSilent,
      lowerBound: 0.20, // HNR_SCORE_FLOOR — maps to score 0
      upperBound: 0.60, // HNR_SCORE_CEIL  — maps to score 100
    },
    bowSmoothness: {
      abruptChangeCount: abrupt,
      rmsFrameCount: rms.length,
      abruptRatio: rms.length > 0 ? abrupt / rms.length : 0,
      changeThreshold: 0.12,
    },
    rhythmAccuracy: { onsetCount: onsets.length, meanIoi, cvIoi, fluxOnsets: fluxOnsets.length, pitchOnsets: pitchOnsets.length },
    dynamicControl: { fastVar },
    vibrato: { eligibleSegments: debugEligibleSegments, avgNoteScore: debugAvgNoteScore, notes: debugNotes },
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
  const fluxOnsets  = computeSpectralFluxOnsets(samples, sampleRate);
  const pitchOnsets = detectPitchChangeOnsets(pitches);
  const uncollapsedOnsets = mergeOnsets(fluxOnsets, pitchOnsets);
  const onsets      = collapseAdjacentSameNoteOnsets(uncollapsedOnsets, pitches, duration);

  const timbreFrames = computeTimbreFrames(samples, sampleRate);

  const { metric: vibratoMetric, analysis: vibratoAnalysis } = scoreVibrato(pitches, onsets);
  const { metric: intonationStabilityMetric, analysis: intonationStabilityAnalysis } = scoreIntonationStability(pitches);
  const { metric: rhythmMetric, analysis: rhythmAnalysis } = scoreRhythmAccuracy(onsets);
  const metrics = [
    scorePitchAccuracy(pitches, duration),
    intonationStabilityMetric,
    scoreToneQuality(samples, sampleRate, duration, pitches),
    scoreBowSmoothness(rms, rmsHop, sampleRate),
    rhythmMetric,
    scoreDynamicControl(rms, rmsHop, sampleRate, pitches),
    vibratoMetric,
  ];

  const intonationAnalysis = analyzeIntonation(pitches);

  const rawSignals: RawAudioSignals = {
    pitchFrames: pitches,
    rmsFrames: Array.from(rms).map((value, i) => ({ value, timestamp: (i * rmsHop) / sampleRate })),
    toneFrames:             timbreFrames.map(({ fundamentalRatio, timestamp }) => ({ fundamentalRatio, timestamp })),
    spectralCentroidFrames: timbreFrames.map(({ spectralCentroid, timestamp }) => ({ value: spectralCentroid, timestamp })),
    brightnessFrames:       timbreFrames.map(({ brightness, timestamp })       => ({ value: brightness, timestamp })),
    onsetTimestamps: onsets,
    uncollapsedOnsetTimestamps: uncollapsedOnsets,
    sampleRate,
    duration,
  };

  return { metrics, intonationAnalysis, intonationStabilityAnalysis, vibratoAnalysis, rhythmAnalysis, rawSignals };
}

// ─────────────────────────────────────────────────────────────
// Real-time vibrato score from base64 WAV (for live monitoring)
// ─────────────────────────────────────────────────────────────

/**
 * Decode a base64 PCM16 WAV string (from the native ring buffer) and return
 * a vibrato MetricScore. Synchronous — runs on the JS thread.
 * Returns null when the WAV is malformed or has too little data.
 */
export function scoreVibratoFromBase64(b64: string): MetricScore | null {
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const wav = parseWav(bytes);
    if (!wav) return null;
    const pitches = detectPitches(wav.samples, wav.sampleRate);
    return scoreVibrato(pitches).metric;
  } catch {
    return null;
  }
}
