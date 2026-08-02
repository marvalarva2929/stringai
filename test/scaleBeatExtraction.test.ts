/**
 * Scale evaluation using known metronome beat times (not silence-gap guessing).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/scaleBeatExtraction.test.ts
 */

import { runEvaluator } from '../src/lib/runEvaluator';
import { midiToFreq, noteNameToMidi } from '../src/lib/pitchNaming';
import type { EvaluatorParams } from '../src/lib/practiceBlocks';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const SR = 44100;

function tone(freqHz: number, dur: number): Float32Array {
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  const harm = [1, 0.5, 0.33, 0.22];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    out[i] = 0.5 * v / 2;
  }
  return out;
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Float32Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// A generous threshold — this test is about proving beat-based segmentation
// correctness, not pixel-perfect cents accuracy on a synthetic edge-of-buffer tone.
const params: EvaluatorParams = { evaluatorId: 'scale', scaleName: 'G major', centsThreshold: 25 };

// The full up-and-down G major sequence scaleNoteSequence('G major') produces.
const G_MAJOR = ['G3', 'A3', 'B3', 'C4', 'D4', 'E4', 'F#4', 'G4', 'F#4', 'E4', 'D4', 'C4', 'B3', 'A3', 'G3'];
const beatInterval = 1.0; // matches a 60bpm metronome

// ── notes played back-to-back with NO silence gap — beat timestamps still
// segment them correctly, which silence-gap guessing could not do ──────────
{
  const parts: Float32Array[] = [];
  for (const note of G_MAJOR) parts.push(tone(midiToFreq(noteNameToMidi(note)!), beatInterval));
  const samples = concat(parts); // one continuous tone, no gaps at all
  const beatTimestamps = G_MAJOR.map((_, i) => i * beatInterval);

  const result = runEvaluator(params, { samples, sampleRate: SR, beatTimestamps });
  check('beat-timed extraction judges a gapless take', result !== null && result.attempts === 15, `attempts=${result?.attempts}`, );
  check('beat-timed extraction passes a clean gapless scale', result?.passed === true, result?.feedback);
}

// ── without beat timestamps, the same gapless take falls back to silence-gap
// segmentation and collapses into a single attempt (proving the fallback path
// is real, and that beat timing is what fixes it) ───────────────────────────
{
  const parts: Float32Array[] = [];
  for (const note of G_MAJOR) parts.push(tone(midiToFreq(noteNameToMidi(note)!), beatInterval));
  const samples = concat(parts);

  const result = runEvaluator(params, { samples, sampleRate: SR });
  check('without beat timestamps, a gapless take collapses to one attempt', result !== null && result.attempts === 1, `attempts=${result?.attempts}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll scaleBeatExtraction checks passed');
