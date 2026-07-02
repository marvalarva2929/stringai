/**
 * Render the synthetic test signals to WAV so you can listen and sanity-check that
 * "clean / scratch / thin / ..." actually sound the way the detector treats them.
 *
 *   node --experimental-strip-types test/generate-synth.ts
 *   (or: npm run synth:gen) → writes test/fixtures/tone/synthetic/*.wav
 *
 * The generators here are copied verbatim from test/toneAnalysis.test.ts so the audio
 * matches what the tests assert on. Each clip is peak-normalised to 0.9 before writing
 * (purely to avoid digital clipping on playback — clipping would itself add buzz).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SR = 44100;

// ── generators (identical to the test) ──────────────────────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function partials(f0: number, dur: number, amps: number[]): Float32Array {
  const n = Math.floor(SR * dur); const s = new Float32Array(n);
  for (let i = 0; i < n; i++) { const t = i / SR; let v = 0; for (let k = 0; k < amps.length; k++) v += amps[k] * Math.sin(2 * Math.PI * (k + 1) * f0 * t); s[i] = v; }
  return s;
}
function violinTone(f0: number, dur: number, amp = 0.3, harmonics = 18): Float32Array {
  const n = Math.floor(SR * dur); const s = new Float32Array(n);
  const K = Math.min(harmonics, Math.floor(SR / 2 / f0) - 1);
  for (let i = 0; i < n; i++) { const t = i / SR; let v = 0; for (let k = 1; k <= K; k++) v += Math.sin(2 * Math.PI * k * f0 * t) / Math.sqrt(k); s[i] = amp * v; }
  return s;
}
function addNoise(sig: Float32Array, amp: number, seed = 1): Float32Array {
  const rnd = mulberry32(seed); const s = Float32Array.from(sig);
  for (let i = 0; i < s.length; i++) s[i] += amp * (rnd() * 2 - 1);
  return s;
}
function addTone(sig: Float32Array, f: number, amp: number): Float32Array {
  const s = Float32Array.from(sig);
  for (let i = 0; i < s.length; i++) s[i] += amp * Math.sin(2 * Math.PI * f * (i / SR));
  return s;
}
function shape(f0: number, dur: number, env: (t: number) => number, noise: (t: number) => number, seed = 7): Float32Array {
  const base = violinTone(f0, dur, 0.3); const rnd = mulberry32(seed); const s = new Float32Array(base.length);
  for (let i = 0; i < base.length; i++) { const t = i / SR; s[i] = env(t) * base[i] + noise(t) * (rnd() * 2 - 1); }
  return s;
}
function concat(...parts: Float32Array[]): Float32Array {
  const total = parts.reduce((n, p) => n + p.length, 0); const out = new Float32Array(total);
  let o = 0; for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// ── WAV writer (PCM16 mono), peak-normalised to 0.9 ─────────────
function writeWav(path: string, samples: Float32Array): void {
  let peak = 1e-9;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const g = 0.9 / peak;
  const n = samples.length;
  const buf = Buffer.alloc(44 + n * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28);
  buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40);
  for (let i = 0; i < n; i++) {
    const v = Math.max(-1, Math.min(1, samples[i] * g));
    buf.writeInt16LE(Math.round(v * 32767), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// ── the clips (mirroring the test cases) ────────────────────────
const F = 293.66; // D4
const clips: Record<string, Float32Array> = {
  '01_clean':           violinTone(F, 2.0),
  '02_scratchy':        addNoise(violinTone(F, 2.0), 0.55, 5),
  '03_crunch_subharm':  addNoise(addTone(violinTone(F, 2.0), F / 2, 0.35), 0.25, 9),
  '04_thin_dull':       partials(F, 2.0, [0.05, 0.03, 0.015]),
  '05_ponticello':      partials(F, 2.0, [0.03, 0.02, 0.02, 0.03, 0.04, 0.06, 0.1, 0.16, 0.24, 0.3, 0.3, 0.26, 0.2, 0.15, 0.1, 0.07]),
  '06_onset_scratch':   shape(F, 1.6, () => 1, (t) => (t < 0.18 ? 0.4 : 0)),
  '07_delayed_speech':  shape(F, 1.6, (t) => (t < 0.18 ? 0.18 : 1), (t) => (t < 0.18 ? 0.12 : 0)),
  '08_decay':           shape(F, 1.8, () => 1, (t) => (t > 1.1 ? 0.45 : 0)),
  '09_flicker':         shape(F, 2.0, () => 1, (t) => (Math.floor(t / 0.08) % 2 ? 0.35 : 0)),
  '10_two_sections_thin_then_scratch': concat(
    partials(F, 1.6, [0.3, 0.02, 0.01]),
    new Float32Array(Math.floor(SR * 0.4)),
    addNoise(violinTone(F, 1.6, 0.45), 0.5, 11),
  ),
};

const outDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'tone', 'synthetic');
mkdirSync(outDir, { recursive: true });
for (const [name, sig] of Object.entries(clips)) {
  const path = join(outDir, `${name}.wav`);
  writeWav(path, sig);
  console.log(`  wrote ${name}.wav  (${(sig.length / SR).toFixed(1)}s)`);
}
console.log(`\nListen:  afplay "${outDir}/01_clean.wav"   (or open the folder)`);
