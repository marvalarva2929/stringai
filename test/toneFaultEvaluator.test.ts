/**
 * toneFaultEvaluator tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/toneFaultEvaluator.test.ts
 */

import { evaluateToneFault } from '../src/lib/toneFaultEvaluator';

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

// Same synth helpers as test/toneAnalysis.test.ts, which classifyFrames is
// calibrated against.
function mulberry32(seed: number) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function violinTone(f0: number, dur: number, amp = 0.3, harmonics = 18): Float32Array {
  const n = Math.floor(SR * dur);
  const s = new Float32Array(n);
  const K = Math.min(harmonics, Math.floor(SR / 2 / f0) - 1);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 1; k <= K; k++) v += Math.sin(2 * Math.PI * k * f0 * t) / Math.sqrt(k);
    s[i] = amp * v;
  }
  return s;
}

// Strong fundamental, weak overtones — reads as 'thin' (hollow) per classifyFrames.
function thinTone(f0: number, dur: number): Float32Array {
  const n = Math.floor(SR * dur);
  const s = new Float32Array(n);
  const amps = [0.3, 0.02, 0.01];
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    let v = 0;
    for (let k = 0; k < amps.length; k++) v += amps[k] * Math.sin(2 * Math.PI * (k + 1) * f0 * t);
    s[i] = v;
  }
  return s;
}

function addNoise(sig: Float32Array, amp: number, seed = 1): Float32Array {
  const rnd = mulberry32(seed);
  const s = Float32Array.from(sig);
  for (let i = 0; i < s.length; i++) s[i] += amp * (rnd() * 2 - 1);
  return s;
}

// ── clean tone passes a scratch/rasp/thin check ─────────────────────────────
{
  const take = violinTone(293.66, 2.0);
  const result = evaluateToneFault(take, SR, { requiredCleanFraction: 0.7 });
  check('clean violin tone passes a 70% clean-fraction check', result.passed === true, result.feedback);
  check('clean tone produces judged windows', result.attempts > 0, `attempts=${result.attempts}`);
}

// ── heavily over-pressed (noisy) tone fails a scratch check ─────────────────
{
  const take = addNoise(violinTone(293.66, 2.0, 0.45), 0.55, 5);
  const result = evaluateToneFault(take, SR, { requiredCleanFraction: 0.7 });
  check('scratchy tone fails the default (any-fault) check', result.passed === false, result.feedback);
}

// ── disallowedFaults scoping: a thin tone fails a thin-specific check ───────
{
  const take = thinTone(293.66, 2.0);
  const thinCheck = evaluateToneFault(take, SR, { disallowedFaults: ['thin'], requiredCleanFraction: 0.7 });
  check('thin tone fails a check that disallows thin', thinCheck.passed === false, thinCheck.feedback);

  // The same clip should not be judged against a scratch-only check as if it
  // were scratchy — 'thin' isn't in scratch's disallowed list, so it passes.
  const scratchCheck = evaluateToneFault(take, SR, { disallowedFaults: ['scratch'], requiredCleanFraction: 0.7 });
  check('thin tone passes a check that only disallows scratch', scratchCheck.passed === true, scratchCheck.feedback);
}

// ── silence can't be judged ──────────────────────────────────────────────────
{
  const take = new Float32Array(Math.floor(SR * 1.5));
  const result = evaluateToneFault(take, SR, { requiredCleanFraction: 0.7 });
  check('silence yields zero attempts (unjudgeable)', result.attempts === 0 && result.passed === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll toneFaultEvaluator checks passed');
