/**
 * Intonation-stability test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/intonationStability.test.ts
 *   (or: npm run test:intonation)
 *
 * Feeds synthetic PitchFrame[] (no audio decode) straight into scoreIntonationStability
 * to lock in the vibrato-aware behaviour: a deliberate, periodic vibrato must NOT be
 * scored as instability, while genuine slow pitch drift still must be.
 */

import type { PitchFrame } from '../src/services/dsp';
import { scoreIntonationStability, classifyVibratoSegment } from '../src/services/pitchContour';

const HOP_S = 0.025; // 40 Hz pitch frame rate, matching detectPitches

// ── deterministic PRNG so noise-based tests never flake ──────────
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Builds one sustained note as a pitch-frame sequence.
 * devCents(t) returns the intended pitch deviation (cents) from baseHz at time t.
 */
function buildNote(
  baseHz: number,
  durS: number,
  devCents: (t: number) => number,
  noiseAmpCents = 0,
  rng: () => number = () => 0.5,
): PitchFrame[] {
  const frames: PitchFrame[] = [];
  for (let t = 0; t < durS; t += HOP_S) {
    const noise = noiseAmpCents > 0 ? (rng() * 2 - 1) * noiseAmpCents : 0;
    const cents = devCents(t) + noise;
    frames.push({ frequency: baseHz * 2 ** (cents / 1200), timestamp: t, periodicity: 0.95 });
  }
  return frames;
}

const sine = (ampCents: number, rateHz: number) => (t: number) => ampCents * Math.sin(2 * Math.PI * rateHz * t);
const ramp = (totalCents: number, durS: number) => (t: number) => (totalCents / durS) * t;

let pass = 0, fail = 0;
const log = (ok: boolean, msg: string) => { ok ? pass++ : fail++; console.log(`${ok ? '  ✓' : '  ✗ FAIL'} ${msg}`); };

const DUR = 1.5;

// ── 1. Pure, healthy vibrato on a steady center ──────────────────
// This is the regression case: before the fix this scored ~1 and was flagged "Pitch wavers".
console.log('\nPure vibrato (steady center):');
{
  const m = scoreIntonationStability(buildNote(440, DUR, sine(25, 5.5))).metric;
  console.log(`  score=${m.score} flags=${m.flaggedTimestamps.length} :: "${m.observationSummary}"`);
  log(m.score >= 80, `healthy ±25¢ / 5.5 Hz vibrato scores high (got ${m.score}, want ≥80)`);
  log(m.flaggedTimestamps.length === 0, 'healthy vibrato is not flagged as wavering');
  // Sanity: the vibrato classifier agrees this IS vibrato.
  const medianFreq = 440;
  const devs = buildNote(440, DUR, sine(25, 5.5)).map((f) => 1200 * Math.log2(f.frequency! / medianFreq));
  log(classifyVibratoSegment(devs, 1 / HOP_S).isVibrato, 'classifier confirms the segment is vibrato');
}

// ── 2. Slow pitch drift, no vibrato (genuine instability) ────────
console.log('\nSlow drift (no vibrato):');
{
  const m = scoreIntonationStability(buildNote(440, DUR, ramp(80, DUR))).metric;
  console.log(`  score=${m.score} flags=${m.flaggedTimestamps.length} :: "${m.observationSummary}"`);
  log(m.score < 55, `an 80¢ pitch drift scores low (got ${m.score}, want <55)`);
  log(m.flaggedTimestamps.length >= 1, 'pitch drift is flagged as wavering');
}

// ── 3. Vibrato + drift: the drift must still be caught ───────────
console.log('\nVibrato + drift:');
{
  const pure = scoreIntonationStability(buildNote(440, DUR, sine(25, 5.5))).metric.score;
  const both = scoreIntonationStability(buildNote(440, DUR, (t) => sine(25, 5.5)(t) + ramp(50, DUR)(t))).metric;
  console.log(`  pureVibrato=${pure} vibrato+drift=${both.score} flags=${both.flaggedTimestamps.length}`);
  log(both.score < 65, `drift under vibrato is still penalised (got ${both.score}, want <65)`);
  log(pure - both.score >= 25, `detrend does not hide drift (Δ=${pure - both.score}, want ≥25)`);
}

// ── 4. Flat, steady note: near-perfect ───────────────────────────
console.log('\nFlat steady note:');
{
  const m = scoreIntonationStability(buildNote(440, DUR, () => 0, 2, mulberry32(7))).metric;
  console.log(`  score=${m.score} flags=${m.flaggedTimestamps.length}`);
  log(m.score >= 90, `a rock-steady note scores near 100 (got ${m.score}, want ≥90)`);
  log(m.flaggedTimestamps.length === 0, 'a steady note is not flagged');
}

console.log(`\n${fail === 0 ? '✓ all' : '✗'} ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
