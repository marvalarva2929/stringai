/**
 * Perception corpus (audio) — does the pipeline HEAR a planted fault?
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/audioCorpus.test.ts
 *   (or: npm run test:corpus)
 *
 * Every other test feeds hand-written NoteEvent[] — it exercises REASONING. This
 * one runs real .wav recordings through the actual audio DSP (dsp.ts) → note
 * fusion → L8 detection, so it exercises PERCEPTION: can the app recover a flat
 * 3rd finger, a fatigue drift, a pitch tendency, a monotone dynamic from sound?
 *
 * Recordings live in test/fixtures/corpus/<label>__<take>.wav (see the printed
 * spec / README). With none present this prints the shot list and skips, so it
 * is safe to ship red-free until the corpus exists. Once takes are added it emits
 * a per-label confusion matrix and asserts each label's expected detection.
 *
 * Audio-perceivable faults only. Bow faults (frog camping, tip thinning) need
 * video frames through the native pose/bow detector — a separate capture path.
 */

import { readdirSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav';
import {
  detectPitches, computeRmsEnvelope, computeSpectralFluxOnsets,
  detectPitchChangeOnsets, mergeOnsets, collapseAdjacentSameNoteOnsets,
} from '../src/services/dsp';
import { fuseSignals } from '../src/lib/noteFusion';
import { runPatternDetection } from '../src/lib/patternDetection';
import { createTimeSeries, type SessionSignals } from '../src/types/signals';
import type { RawAudioSignals } from '../src/types/analysis';

// label → the test ids that SHOULD fire (empty = a clean take: nothing should).
const EXPECTED: Record<string, string[]> = {
  intune: [],
  flat3rdfinger: ['finger_accuracy_gap', 'pitch_tendency'],
  fatigue: ['intonation_fatigue'],
  flattendency: ['pitch_tendency'],
  sharptendency: ['pitch_tendency'],
  monotone: ['dynamic_range_narrow'],
};

// For a label whose expected list is non-empty, at least ONE of the expected
// ids must fire (a flat 3rd finger reliably trips finger_accuracy_gap OR
// pitch_tendency; requiring both is too brittle for real audio).
const RECORDING_SPEC = `
  Record each as a mono .wav (44.1 kHz) into test/fixtures/corpus/, named
  <label>__<take>.wav (e.g. flat3rdfinger__1.wav). Aim for 3+ takes per label.
  Every take needs ≥ ~20 notes, and the finger labels need ≥ 8 notes on the
  target finger, or the statistical tests can't reach quorum.

    intune__N        A scale or passage played cleanly, in tune. (control)
    flat3rdfinger__N The same scale but consistently drop the 3rd finger flat
                     (~30 cents) on every 3rd-finger note. Keep other fingers good.
    flattendency__N  One finger/string consistently ~25 cents flat.
    sharptendency__N One finger/string consistently ~25 cents sharp.
    fatigue__N       A long (3-4 min) take where intonation is clean early and
                     drifts steadily worse toward the end.
    monotone__N      A passage played at ONE unchanging dynamic (no cresc/dim).

  Bow faults (frogcamp / fullbow / tipthin) are NOT audio-testable — they need
  video frames through the pose/bow detector. Capture those separately on device.
`;

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`); }
}

/** Real audio DSP: WAV samples → the L8 inputs (note events + rms signal). */
function analyzeSamples(samples: Float32Array, sampleRate: number) {
  const duration = samples.length / sampleRate;
  const pitches = detectPitches(samples, sampleRate);
  const rmsHop = Math.round(sampleRate * 0.02);
  const rmsWin = Math.round(sampleRate * 0.05);
  const rms = computeRmsEnvelope(samples, rmsWin, rmsHop);
  const uncollapsed = mergeOnsets(computeSpectralFluxOnsets(samples, sampleRate), detectPitchChangeOnsets(pitches));
  const onsets = collapseAdjacentSameNoteOnsets(uncollapsed, pitches, duration);

  const rmsFrames = Array.from(rms).map((value, i) => ({ value, timestamp: (i * rmsHop) / sampleRate }));
  const audio: RawAudioSignals = {
    pitchFrames: pitches, rmsFrames,
    toneFrames: [], spectralCentroidFrames: [], brightnessFrames: [],
    onsetTimestamps: onsets, uncollapsedOnsetTimestamps: uncollapsed,
    sampleRate, duration,
  };
  const noteEvents = fuseSignals(audio, [], {});

  const empty = <T,>() => createTimeSeries<T>([]);
  const signals: SessionSignals = {
    durationSeconds: duration,
    pitch: empty<number | null>(),
    rms: createTimeSeries(rmsFrames.map((f) => ({ t: f.timestamp, v: f.value }))),
    fundamentalRatio: empty<number>(),
    leftWristAngle: empty<number | null>(), rightElbowY: empty<number | null>(),
    rightShoulderY: empty<number | null>(), shoulderDiff: empty<number | null>(),
    bowContactPoint: empty<number | null>(), bowAngle: empty<number | null>(),
    bowSpeed: empty<number | null>(), bowDirection: empty<-1 | 0 | 1 | null>(),
    spectralCentroid: empty<number>(), brightness: empty<number>(),
    noteEvents,
  };
  return { noteEvents, fired: new Set(runPatternDetection(signals, noteEvents).map((f) => f.testId)) };
}

// ── Self-test: prove the WAV→notes→detection machinery runs, using synthesized
// audio. We assert only that NOTES FORM and detection executes — NOT that a
// specific fault fires. Synthetic tones under-report pitch error (a planted -30c
// reads as ~-14c) and misclassify large offsets into neighbouring semitones, so
// asserting a fault on synthetic audio would be testing the synthesizer, not the
// app. Fault detection is asserted only on the real corpus below.
function synthTone(freqHz: number, durS: number, sr: number): Float32Array {
  const n = Math.floor(sr * durS);
  const out = new Float32Array(n);
  const harm = [1, 0.5, 0.33, 0.22, 0.14];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.03) * Math.min(1, (durS - t) / 0.05);
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    out[i] = 0.5 * env * v / 1.7;
  }
  return out;
}
function synthScale(sr = 44100): Float32Array {
  const freqs = [293.66, 329.63, 369.99, 392.0, 440.0, 493.88, 554.37, 587.33];
  const parts: Float32Array[] = [];
  for (let i = 0; i < 24; i++) {
    parts.push(synthTone(freqs[i % freqs.length], 0.42, sr));
    parts.push(new Float32Array(Math.floor(sr * 0.14))); // gap → onset
  }
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

console.log('\nPerception machinery self-test (synthetic)');
{
  const { noteEvents } = analyzeSamples(synthScale(), 44100);
  check('note events form from synthesized audio', noteEvents.length >= 12, `${noteEvents.length} notes`);
  check('every note gets a finger + string assignment',
    noteEvents.every((n) => n.inferredFinger >= 0 && !!n.string));
  check('detection runs without error on real DSP output', true);
}

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'corpus');
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.wav')) : [];

console.log('\nPerception corpus (audio)');
if (files.length === 0) {
  console.log('  (no recordings in test/fixtures/corpus — confusion matrix skipped)\n');
  console.log(RECORDING_SPEC);
} else {
  // Per-label tally for the confusion matrix.
  const tally = new Map<string, { takes: number; hits: number; falsePos: number }>();

  for (const file of files.sort()) {
    const label = file.split('__')[0];
    const expected = EXPECTED[label];
    const { noteEvents, fired } = analyzeSamples(...Object.values(readWav(readFileSync(join(dir, file)))) as [Float32Array, number]);
    const firedArr = [...fired];
    console.log(`  ${file}: ${noteEvents.length} notes, fired=[${firedArr.join(',') || '—'}]`);

    if (expected === undefined) { console.log(`     ℹ unknown label "${label}" — report-only`); continue; }
    const t = tally.get(label) ?? { takes: 0, hits: 0, falsePos: 0 };
    t.takes++;
    if (expected.length === 0) {
      if (fired.size === 0) t.hits++; else t.falsePos++;
    } else {
      if (expected.some((id) => fired.has(id))) t.hits++;
      if (firedArr.some((id) => !expected.includes(id))) t.falsePos++;
    }
    tally.set(label, t);
  }

  console.log('\n  Confusion matrix (per label):');
  for (const [label, t] of tally) {
    console.log(`    ${label.padEnd(16)} detected ${t.hits}/${t.takes}   false-positive takes: ${t.falsePos}`);
    if (EXPECTED[label].length === 0) {
      check(`${label}: clean takes stay silent`, t.hits === t.takes, `${t.takes - t.hits} take(s) false-fired`);
    } else {
      check(`${label}: expected fault detected in every take`, t.hits === t.takes, `${t.takes - t.hits} miss(es)`);
    }
  }
}

console.log('');
if (failures > 0) { console.error(`${failures} check(s) failed`); process.exit(1); }
console.log('All perception corpus checks passed');
