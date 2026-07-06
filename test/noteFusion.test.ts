/**
 * Note fusion (L2) test harness — hybrid onset splitting + bow field population.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/noteFusion.test.ts
 *   (or: npm run test:notefusion)
 *
 * Builds synthetic pitch/RMS frames plus a synthetic bow series and checks:
 * repeated same-pitch notes split at bow-corroborated onsets, no splitting
 * happens without bow data (degradation), and NoteEvent bow fields carry the
 * median contact point / angle over each note window.
 */

import { fuseSignals } from '../src/lib/noteFusion';
import { deriveBowTimeSeries } from '../src/lib/bowAnalysis';
import type { RawAudioSignals } from '../src/types/analysis';
import type { RawBowFrame } from '../src/types/signals';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const A4 = 440;

/** Audio signals: constant pitch for `duration` seconds at 25ms hop. */
function constantPitchAudio(
  freq: number,
  duration: number,
  uncollapsedOnsets: number[] = [],
): RawAudioSignals {
  const hop = 0.025;
  const n = Math.floor(duration / hop);
  const pitchFrames = Array.from({ length: n }, (_, i) => ({
    frequency: freq as number | null,
    timestamp: i * hop,
  }));
  const rmsFrames = Array.from({ length: n }, (_, i) => ({ value: 0.3, timestamp: i * hop }));
  const toneFrames = Array.from({ length: n }, (_, i) => ({ fundamentalRatio: 0.8, timestamp: i * hop }));
  return {
    pitchFrames,
    rmsFrames,
    toneFrames,
    spectralCentroidFrames: [],
    brightnessFrames: [],
    onsetTimestamps: [],
    uncollapsedOnsetTimestamps: uncollapsedOnsets,
    sampleRate: 44100,
    duration,
  };
}

// Horizontal bow, frog x=0.2 → tip x=0.8.
function bowFrameAtU(t: number, u: number): RawBowFrame {
  return {
    timestamp: t,
    tipX: 0.8, tipY: 0.5, tipVisible: true,
    frogX: 0.2, frogY: 0.5, frogVisible: true,
    contactX: 0.2 + u * 0.6, contactY: 0.5, contactVisible: true,
    confidence: 0.9,
  };
}

/**
 * Détaché bow series over `duration` at 10fps: contact sweeps tipward then
 * frogward, reversing every `strokeS` seconds (direction flips at each reversal).
 */
function detacheBow(duration: number, strokeS: number): RawBowFrame[] {
  const frames: RawBowFrame[] = [];
  for (let t = 0; t < duration; t += 0.1) {
    const phase = (t % (2 * strokeS)) / strokeS; // 0-2
    const u = phase <= 1 ? 0.2 + 0.6 * phase : 0.8 - 0.6 * (phase - 1);
    frames.push(bowFrameAtU(t, u));
  }
  return frames;
}

// ─────────────────────────────────────────────────────────────
console.log('\nNo bow data → same-pitch audio stays one note (degradation)');
{
  // 2s of constant A4 with flux candidates at each second — without bow
  // corroboration nothing may split.
  const audio = constantPitchAudio(A4, 2.0, [0.5, 1.0, 1.5]);
  const events = fuseSignals(audio, []);
  check('exactly 1 note event', events.length === 1, `got ${events.length}`);
  check('bow fields null', events[0]?.bowContactPoint === null && events[0]?.bowAngle === null);
}

console.log('\nBow direction flips split repeated same-pitch notes');
{
  // 2s of constant A4, détaché with 0.5s strokes → reversals at 0.5, 1.0, 1.5.
  // Flux candidates at the same times (as the uncollapsed onset list retains).
  const audio = constantPitchAudio(A4, 2.0, [0.5, 1.0, 1.5]);
  const bow = deriveBowTimeSeries(detacheBow(2.0, 0.5));
  const events = fuseSignals(audio, [], { bow });
  check('one note per stroke (4 events)', events.length === 4, `got ${events.length}: ${events.map(e => `${e.startSeconds.toFixed(2)}-${e.endSeconds.toFixed(2)}`).join(', ')}`);
  check('all same pitch class', events.every(e => e.noteName.startsWith('A')));
}

console.log('\nCandidates without bow change do not split');
{
  // Constant A4 with flux candidates, but the bow sweeps steadily one way —
  // no direction flip, no speed change → candidates are bow noise, no split.
  const audio = constantPitchAudio(A4, 2.0, [0.7, 1.3]);
  const frames: RawBowFrame[] = [];
  for (let t = 0; t < 2.0; t += 0.1) frames.push(bowFrameAtU(t, 0.2 + 0.3 * t));
  const bow = deriveBowTimeSeries(frames);
  const events = fuseSignals(audio, [], { bow });
  check('stays 1 note event', events.length === 1, `got ${events.length}`);
}

console.log('\nNoteEvent bow fields carry median contact point');
{
  const audio = constantPitchAudio(A4, 1.0, []);
  // Bow parked around u = 0.5 for the whole note
  const frames: RawBowFrame[] = [];
  for (let t = 0; t < 1.0; t += 0.1) frames.push(bowFrameAtU(t, 0.5));
  const bow = deriveBowTimeSeries(frames);
  const events = fuseSignals(audio, [], { bow });
  check('1 note event', events.length === 1, `got ${events.length}`);
  const cp = events[0]?.bowContactPoint;
  check('bowContactPoint ≈ 0.5', cp !== null && Math.abs(cp - 0.5) < 0.05, `got ${cp}`);
  const angle = events[0]?.bowAngle;
  check('bowAngle ≈ 0° (horizontal)', angle !== null && Math.abs(angle) < 3, `got ${angle}`);
}

console.log('\nPitch-change segmentation still works with bow present');
{
  // 1s A4 then 1s B4 — two notes regardless of bow
  const hop = 0.025;
  const n = Math.floor(2.0 / hop);
  const pitchFrames = Array.from({ length: n }, (_, i) => ({
    frequency: (i * hop < 1.0 ? A4 : 493.88) as number | null,
    timestamp: i * hop,
  }));
  const audio: RawAudioSignals = {
    ...constantPitchAudio(A4, 2.0, []),
    pitchFrames,
  };
  const bow = deriveBowTimeSeries(detacheBow(2.0, 1.0));
  const events = fuseSignals(audio, [], { bow });
  check('2 note events', events.length === 2, `got ${events.length}`);
  check('A then B', events[0]?.noteName.startsWith('A') === true && events[1]?.noteName.startsWith('B') === true,
    `got ${events.map(e => e.noteName).join(', ')}`);
}

// ─────────────────────────────────────────────────────────────
console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) failed`);
  process.exit(1);
}
console.log('All note fusion checks passed');
