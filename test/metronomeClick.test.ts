/**
 * Metronome click harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/metronomeClick.test.ts
 *   (or: npm run test:click)
 *
 * The click is played on the beat and the phone's speaker sits inches from its own
 * mic, so the click is always in the recording. These checks assert it cannot be
 * read as a note — alone, or mixed under real violin recordings from the fixture
 * corpus — and that it stays loud enough to play to.
 *
 * The regression this guards: the click used to be a 1 kHz sine held for 50 ms,
 * detected at periodicity 0.998 as B5 +27¢, twice per beat, in every path that
 * reads pitch. Part B measures the current click against that old one directly, so
 * the improvement is a number rather than a claim.
 */

import assert from 'node:assert';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readWav } from './wav';
import { renderClick, buildClickWav, CLICK_SAMPLE_RATE, CLICK_DURATION_S } from '../src/lib/clickTone';
import { detectPitches, computeSpectralFluxOnsets, magnitudeSpectrum, type PitchFrame } from '../src/services/dsp';

const SR = CLICK_SAMPLE_RATE;
const MAX_VIOLIN_HZ = 2100; // dsp.ts hard-rejects pitches outside 180–2100
let failures = 0;

function check(ok: boolean, label: string, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`);
  if (!ok) failures++;
}

/** The click as it shipped before this was fixed — the regression baseline. */
function renderLegacyClick(sampleRate: number): Float32Array {
  const n = Math.round(sampleRate * 0.05);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sampleRate;
    out[i] = Math.exp(-t * 60) * 0.8 * Math.sin(2 * Math.PI * 1000 * t);
  }
  return out;
}

/** Linear resample — models the click asset being played back at the mic's rate. */
function resample(src: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return src;
  const n = Math.round(src.length * to / from);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = i * from / to;
    const i0 = Math.floor(x);
    const frac = x - i0;
    out[i] = (src[i0] ?? 0) * (1 - frac) + (src[i0 + 1] ?? 0) * frac;
  }
  return out;
}

/** Lays clicks on the beat over a bed (or silence), scaled to `gain`. */
function layClicks(
  bed: Float32Array, sampleRate: number, bpm: number, click: Float32Array, gain = 1,
): Float32Array {
  const out = Float32Array.from(bed);
  const period = 60 / bpm;
  const seconds = out.length / sampleRate;
  for (let beat = 0; beat * period < seconds; beat++) {
    const off = Math.round(beat * period * sampleRate);
    for (let i = 0; i < click.length && off + i < out.length; i++) out[off + i] += click[i] * gain;
  }
  return out;
}

const peakOf = (b: Float32Array) => b.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
const voicedOf = (f: PitchFrame[]) => f.filter((p) => p.frequency !== null);

// ─── Part A: intrinsic properties ────────────────────────────────────────────

console.log('── click in isolation ──');

// Silence + clicks: any voiced frame here is a phantom note, by construction.
for (const bpm of [60, 208]) {
  const buf = layClicks(new Float32Array(SR * 4), SR, bpm, renderClick());
  const voiced = voicedOf(detectPitches(buf, SR));
  check(voiced.length === 0, `click alone yields no pitch at ${bpm} bpm`,
    voiced.length ? voiced.slice(0, 3).map((f) => `${f.frequency!.toFixed(0)}Hz@${f.periodicity!.toFixed(2)}`).join(' ') : '');
}

// A speaker held right against the mic.
{
  const buf = layClicks(new Float32Array(SR * 4), SR, 60, renderClick(), 2.0);
  const voiced = voicedOf(detectPitches(buf, SR));
  check(voiced.length === 0, 'click at 2x gain still yields no pitch',
    voiced.length ? `${voiced.length} voiced frames` : '');
}

// Aperiodicity is the load-bearing property, not pitch height: a pure tone above
// MAX_VIOLIN_HZ still leaks, because YIN locks onto its subharmonics.
{
  const pureHigh = new Float32Array(Math.round(SR * 0.012));
  for (let i = 0; i < pureHigh.length; i++) {
    const t = i / SR;
    pureHigh[i] = Math.exp(-t * 250) * 0.8 * Math.sin(2 * Math.PI * 3500 * t);
  }
  const leaks = voicedOf(detectPitches(layClicks(new Float32Array(SR * 4), SR, 60, pureHigh), SR));
  check(leaks.length > 0, 'control: a pure 3.5 kHz tick DOES leak (why noise, not a high beep)',
    leaks.length ? `${leaks.slice(0, 2).map((f) => `${f.frequency!.toFixed(0)}Hz`).join(' ')} — subharmonics of 3500` : 'no leak?!');
}

// The body deliberately sits INSIDE the violin's range — that is what makes it read as
// a metronome rather than a hiss — so spectral placement is not what keeps it safe.
// Pin where the energy actually is, so an accidental move is visible.
{
  const fft = 1024;
  const padded = new Float32Array(fft);
  const click = renderClick();
  padded.set(click.subarray(0, Math.min(fft, click.length)));
  const mag = magnitudeSpectrum(padded, 0, fft);
  const binHz = SR / fft;
  let peakBin = 1;
  for (let k = 2; k < mag.length; k++) if (mag[k] > mag[peakBin]) peakBin = k;
  const centre = peakBin * binHz;
  check(centre > 600 && centre < MAX_VIOLIN_HZ, 'click body sits in the mid-range, where it reads as a tick',
    `peak at ${centre.toFixed(0)} Hz`);
}

// Q is the dial that trades sound against detectability, so guard it: a sharply
// resonant version of the same design must measurably degrade. If this ever stops
// failing, the aperiodicity argument has broken and the safety margin is gone.
{
  const n = Math.round(SR * CLICK_DURATION_S);
  let s = 0x5eed1;
  const rand = () => { s |= 0; s = s + 0x6D2B79F5 | 0; let t = Math.imul(s ^ s >>> 15, 1 | s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const w0 = 2 * Math.PI * 1400 / SR, Q = 14;
  const alpha = Math.sin(w0) / (2 * Q), a0 = 1 + alpha;
  const b0 = Q * alpha / a0, b2 = -Q * alpha / a0, a1 = -2 * Math.cos(w0) / a0, a2 = (1 - alpha) / a0;
  const ringy = new Float32Array(n);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0, pk = 0;
  for (let i = 0; i < n; i++) {
    const x = rand() * 2 - 1;
    const y = b0 * x + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x; y2 = y1; y1 = y;
    ringy[i] = Math.exp((-i / SR) * 150) * y;
    pk = Math.max(pk, Math.abs(ringy[i]));
  }
  for (let i = 0; i < n; i++) ringy[i] *= 0.9 / pk;
  const leak = voicedOf(detectPitches(layClicks(new Float32Array(SR * 4), SR, 60, ringy), SR));
  check(leak.length > 0, 'control: a high-Q (ringing) tick DOES leak — Q is the safety dial',
    leak.length ? `${leak.slice(0, 2).map((f) => `${f.frequency!.toFixed(0)}Hz`).join(' ')} at Q=14` : 'no leak at Q=14?!');
}

// ─── Part B: mixed under real violin recordings ──────────────────────────────
// The corpus is the only place these numbers mean anything: a synthetic tone has
// no bow noise, no attack transients and no room, all of which change the
// detector's behaviour around a click.

const fixturesRoot = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const takes: { name: string; samples: Float32Array; sampleRate: number }[] = [];
for (const dir of ['intonation', 'tone']) {
  const d = join(fixturesRoot, dir);
  if (!existsSync(d)) continue;
  for (const f of readdirSync(d).filter((n) => n.endsWith('.wav')).sort().slice(0, 6)) {
    const { samples, sampleRate } = readWav(readFileSync(join(d, f)));
    if (samples.length > sampleRate * 1.5) takes.push({ name: `${dir}/${f}`, samples, sampleRate });
  }
}

if (takes.length === 0) {
  console.log('\n── real recordings ── SKIPPED (no fixtures under test/fixtures/{intonation,tone})');
} else {
  console.log(`\n── mixed under ${takes.length} real recordings (click at take peak, 80 bpm) ──`);

  let curPhantom = 0, curShifted = 0, curOnsetDelta = 0;
  let oldPhantom = 0, oldShifted = 0, oldOnsetDelta = 0;
  let totalBaseFrames = 0;

  for (const take of takes) {
    const { samples, sampleRate } = take;
    const takePeak = peakOf(samples) || 1;

    const base = detectPitches(samples, sampleRate);
    const baseVoiced = voicedOf(base);
    const baseOnsets = computeSpectralFluxOnsets(samples, sampleRate).length;
    totalBaseFrames += baseVoiced.length;

    for (const variant of ['current', 'legacy'] as const) {
      const raw = variant === 'current'
        ? resample(renderClick(), SR, sampleRate)
        : renderLegacyClick(sampleRate);
      // Match the click's peak to the recording's, i.e. a loud metronome.
      const mixed = layClicks(samples, sampleRate, 80, raw, takePeak / peakOf(raw));

      const after = detectPitches(mixed, sampleRate);
      // Phantom: a frame that was unvoiced in the clean take but voiced with the click.
      // Shifted: a frame voiced in both, but moved more than 25¢ — the click bending a real note.
      let phantom = 0, shifted = 0;
      for (let i = 0; i < Math.min(base.length, after.length); i++) {
        const b = base[i].frequency, a = after[i].frequency;
        if (b === null && a !== null) phantom++;
        else if (b !== null && a !== null && Math.abs(1200 * Math.log2(a / b)) > 25) shifted++;
      }
      const onsetDelta = Math.abs(computeSpectralFluxOnsets(mixed, sampleRate).length - baseOnsets);

      if (variant === 'current') { curPhantom += phantom; curShifted += shifted; curOnsetDelta += onsetDelta; }
      else { oldPhantom += phantom; oldShifted += shifted; oldOnsetDelta += onsetDelta; }
    }
  }

  const pct = (n: number) => `${((n / Math.max(1, totalBaseFrames)) * 100).toFixed(1)}%`;
  console.log(`  legacy 1 kHz sine : phantom=${oldPhantom} (${pct(oldPhantom)})  shifted=${oldShifted} (${pct(oldShifted)})  Δonsets=${oldOnsetDelta}`);
  console.log(`  current noise tick: phantom=${curPhantom} (${pct(curPhantom)})  shifted=${curShifted} (${pct(curShifted)})  Δonsets=${curOnsetDelta}`);
  console.log(`  (${totalBaseFrames} voiced frames across ${takes.length} takes)`);

  // Budgets, not zeroes: the click is mixed here at the recording's own peak level,
  // which is a louder metronome than any real take. A handful of frames at that
  // level is fine; a systematic per-beat phantom note is the thing being caught.
  check(curPhantom <= totalBaseFrames * 0.005, 'effectively no phantom notes under real playing',
    `${curPhantom} added voiced frames (${pct(curPhantom)}), budget 0.5%`);
  check(curShifted <= totalBaseFrames * 0.01, 'click bends almost no real frames off pitch',
    `${curShifted} shifted (${pct(curShifted)}), budget 1%`);
  check(curPhantom * 10 < oldPhantom, 'an order of magnitude fewer phantom notes than the old click',
    `${curPhantom} vs ${oldPhantom}`);
  check(curShifted * 10 < oldShifted, 'an order of magnitude fewer bent frames than the old click',
    `${curShifted} vs ${oldShifted}`);

  // Onsets are NOT fixed by this change and must not be claimed as fixed. The click
  // is an audible transient, so it trips the spectral-flux detector exactly as the
  // old one did — see the note in scoreRhythmAccuracy's caller. Recorded here so the
  // number is visible rather than forgotten.
  console.log(`  note: click still adds ~${curOnsetDelta} spectral-flux onsets (old click: ${oldOnsetDelta}) — unfixed, see clickTone.ts`);
}

// ─── Part C: the asset itself ────────────────────────────────────────────────

console.log('\n── WAV asset ──');
{
  const wav = buildClickWav();
  const v = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (off: number) => String.fromCharCode(...[0, 1, 2, 3].map((i) => v.getUint8(off + i)));
  const expected = Math.round(SR * CLICK_DURATION_S);
  assert.strictEqual(tag(0), 'RIFF');
  assert.strictEqual(tag(8), 'WAVE');
  assert.strictEqual(v.getUint32(24, true), SR, 'sample rate');
  assert.strictEqual(v.getUint16(22, true), 1, 'mono');
  assert.strictEqual(v.getUint32(40, true), expected * 2, 'data chunk size');
  assert.strictEqual(wav.length, 44 + expected * 2, 'file size');
  console.log('PASS  WAV container is well-formed');

  // The cached file is written once per install, so the render must be stable.
  assert.deepStrictEqual(Array.from(buildClickWav()), Array.from(wav));
  console.log('PASS  click render is deterministic');

  const peak = peakOf(renderClick());
  check(peak > 0.85 && peak <= 1, 'click is loud enough to play to', `peak ${peak.toFixed(2)}`);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll metronome click checks passed.');
