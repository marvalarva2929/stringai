/**
 * Vibrato fault-classification test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/vibratoDiagnosis.test.ts
 *   (or: npm run test:vibratodiag)
 *
 * Locks in classifyVibratoFaults / hasVibrato — the numeric fault classification
 * the results UI uses instead of matching the engine's English feedback strings.
 */

import assert from 'node:assert';
import {
  classifyVibratoFaults, hasVibrato, VIBRATO_DISPLAY, classifyVibratoSegment,
} from '../src/services/pitchContour';

type Case = {
  name: string;
  note: { rateHz: number; depthCents: number; periodicityScore: number; consistencyOk: boolean };
  expected: string[];
};

const healthy = { rateHz: 5.5, depthCents: 25, periodicityScore: 0.6, consistencyOk: true };

const cases: Case[] = [
  { name: 'no vibrato (depth-gate early return: rate 0, depth 3)',
    note: { ...healthy, rateHz: 0, depthCents: 3 }, expected: ['none'] },
  { name: 'depth below minimum counts as none even with a rate',
    note: { ...healthy, depthCents: 5 }, expected: ['none'] },
  { name: 'healthy vibrato has no faults',
    note: healthy, expected: [] },
  { name: 'shallow depth',
    note: { ...healthy, depthCents: 12 }, expected: ['shallow'] },
  { name: 'too wide',
    note: { ...healthy, depthCents: 45 }, expected: ['wide'] },
  { name: 'slow rate',
    note: { ...healthy, rateHz: 3.5 }, expected: ['slow'] },
  { name: 'fast rate',
    note: { ...healthy, rateHz: 7.4 }, expected: ['fast'] },
  { name: 'low periodicity',
    note: { ...healthy, periodicityScore: 0.1 }, expected: ['uneven'] },
  { name: 'fades (consistency flag)',
    note: { ...healthy, consistencyOk: false }, expected: ['fades'] },
  { name: 'multi-fault keeps priority order depth > rate > periodicity',
    note: { rateHz: 3.5, depthCents: 12, periodicityScore: 0.1, consistencyOk: true },
    expected: ['shallow', 'slow', 'uneven'] },
  { name: 'hard-gate rate out of range reports only uneven',
    note: { ...healthy, rateHz: 2.5, depthCents: 15 }, expected: ['uneven'] },
  { name: 'boundary: exactly 18¢ is not shallow',
    note: { ...healthy, depthCents: 18 }, expected: [] },
  { name: 'boundary: exactly 7.0 Hz is not fast',
    note: { ...healthy, rateHz: 7.0 }, expected: [] },
  { name: 'boundary: exactly 40¢ is not wide',
    note: { ...healthy, depthCents: 40 }, expected: [] },
];

let failures = 0;
for (const c of cases) {
  const got = classifyVibratoFaults(c.note);
  const ok = JSON.stringify(got) === JSON.stringify(c.expected);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} → [${got.join(', ')}]`);
  if (!ok) {
    failures++;
    console.log(`      expected [${c.expected.join(', ')}]`);
  }
}

// hasVibrato — the presence bar used for the target-strip averages
assert.ok(hasVibrato({ rateHz: 5.5, depthCents: 25 }), 'healthy note has vibrato');
assert.ok(!hasVibrato({ rateHz: 0, depthCents: 3 }), 'no-vibrato note excluded');
assert.ok(!hasVibrato({ rateHz: 2.5, depthCents: 25 }), 'out-of-range rate excluded');
assert.ok(!hasVibrato({ rateHz: 5.5, depthCents: 5 }), 'sub-minimum depth excluded');
console.log('PASS  hasVibrato presence checks');

// Display constants must mirror the scorer's bands
assert.strictEqual(VIBRATO_DISPLAY.RATE_TARGET_LO, 4);
assert.strictEqual(VIBRATO_DISPLAY.RATE_TARGET_HI, 7);
assert.strictEqual(VIBRATO_DISPLAY.DEPTH_TARGET_LO, 18);
assert.strictEqual(VIBRATO_DISPLAY.DEPTH_TARGET_HI, 40);
console.log('PASS  VIBRATO_DISPLAY bands match scorer constants');

// ─── Signal-level detection ──────────────────────────────────────────────────
// The classifier above only sees numbers. These cases run real pitch traces through
// classifyVibratoSegment, which is where "no vibrato" used to be misread as a depth
// or rate fault: a flat note still drifts, scoops and wobbles, and measuring that
// unfiltered gave 20–40¢ of "depth" plus an autocorrelation rate pinned inside 3–8 Hz.

const HOP = 40; // upload YIN pitch-frame rate

function rng(seed: number) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

/** Builds a 2 s cents-deviation trace, median-centred the way the engine feeds it in. */
function trace(fn: (i: number, noise: () => number) => number, n = 80, seed = 7): number[] {
  const r = rng(seed);
  const raw = Array.from({ length: n }, (_, i) => fn(i, r));
  const median = [...raw].sort((a, b) => a - b)[Math.floor(n / 2)];
  return raw.map((v) => v - median);
}

const sine = (rateHz: number, depth: number) => (i: number) =>
  depth * Math.sin(2 * Math.PI * rateHz * i / HOP);

type SignalCase = { name: string; devs: number[]; detected: boolean; rate?: number; depth?: number };

const signalCases: SignalCase[] = [
  // ── No vibrato: every one of these must report absence, not a depth/rate fault ──
  { name: 'flat note, light YIN jitter',
    devs: trace((_i, r) => (r() - 0.5) * 12), detected: false },
  { name: 'flat note, heavy YIN jitter',
    devs: trace((_i, r) => (r() - 0.5) * 40), detected: false },
  { name: 'scooped attack, then steady',
    devs: trace((i, r) => (i < 10 ? -70 * (1 - i / 10) : 0) + (r() - 0.5) * 8), detected: false },
  { name: 'slow drift sharp across the note',
    devs: trace((i, r) => (i / 80) * 50 + (r() - 0.5) * 8), detected: false },
  { name: 'bow-change dip',
    devs: trace((i, r) => 30 * Math.sin(Math.PI * i / 80) + (r() - 0.5) * 8), detected: false },
  { name: 'slide away at the release',
    devs: trace((i, r) => (i > 68 ? (i - 68) * 6 : 0) + (r() - 0.5) * 8), detected: false },
  { name: 'missed onset glued two notes together',
    devs: trace((i, r) => (i > 40 ? 60 : 0) + (r() - 0.5) * 8), detected: false },
  { name: 'slow 1.5 Hz tremble is below the vibrato band',
    devs: trace((i, r) => 20 * Math.sin(2 * Math.PI * 1.5 * i / HOP) + (r() - 0.5) * 8), detected: false },
  { name: 'perfectly flat pitch',
    devs: trace(() => 0), detected: false },

  // ── Real vibrato: must still be detected, with rate and depth intact ──
  { name: 'textbook 5.5 Hz ±25¢',
    devs: trace((i, r) => sine(5.5, 25)(i) + (r() - 0.5) * 6), detected: true, rate: 5.5, depth: 25 },
  { name: 'shallow 5 Hz ±15¢',
    devs: trace((i, r) => sine(5, 15)(i) + (r() - 0.5) * 6), detected: true, rate: 5, depth: 15 },
  { name: 'slow 4 Hz ±30¢',
    devs: trace((i, r) => sine(4, 30)(i) + (r() - 0.5) * 6), detected: true, rate: 4, depth: 30 },
  { name: 'fast 7 Hz ±20¢',
    devs: trace((i, r) => sine(7, 20)(i) + (r() - 0.5) * 6), detected: true, rate: 7, depth: 20 },
  { name: 'wide 6 Hz ±45¢',
    devs: trace((i, r) => sine(6, 45)(i) + (r() - 0.5) * 6), detected: true, rate: 6, depth: 45 },
  { name: 'vibrato riding on 40¢ of drift',
    devs: trace((i, r) => sine(5.5, 25)(i) + (i / 80) * 40 + (r() - 0.5) * 6), detected: true, rate: 5.5, depth: 25 },
  { name: 'vibrato that widens through the note',
    devs: trace((i, r) => (12 + 18 * (i / 80)) * Math.sin(2 * Math.PI * 5 * i / HOP) + (r() - 0.5) * 8),
    detected: true, rate: 5 },
  { name: 'vibrato fading out',
    devs: trace((i, r) => 28 * (1 - i / 80) * Math.sin(2 * Math.PI * 5.5 * i / HOP) + (r() - 0.5) * 6),
    detected: true, rate: 5.5 },
];

console.log('\n── signal-level detection ──');
for (const c of signalCases) {
  const r = classifyVibratoSegment(c.devs, HOP);
  const faults = classifyVibratoFaults({
    rateHz: r.rate, depthCents: r.depth, periodicityScore: r.periodicityScore,
    consistencyOk: r.consistencyOk, detected: r.detected,
  });
  const problems: string[] = [];
  if (r.detected !== c.detected) problems.push(`detected=${r.detected}, want ${c.detected}`);
  // A no-vibrato note must be reported as absent — never as a depth or rate fault.
  if (!c.detected && faults[0] !== 'none') problems.push(`faults=[${faults}], want [none]`);
  // Rate drives the slow/fast verdict; depth drives shallow/wide. Both must survive detrending.
  if (c.rate !== undefined && Math.abs(r.rate - c.rate) > 0.4) problems.push(`rate=${r.rate.toFixed(2)}, want ~${c.rate}`);
  if (c.depth !== undefined && Math.abs(r.depth - c.depth) > c.depth * 0.15) problems.push(`depth=${r.depth.toFixed(1)}, want ~${c.depth}`);

  const ok = problems.length === 0;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} → detected=${r.detected} rate=${r.rate.toFixed(1)} depth=${r.depth.toFixed(1)} [${faults.join(', ')}]`);
  if (!ok) { failures++; problems.forEach((p) => console.log(`      ${p}`)); }
}

// The presence flag must survive the round-trip through a persisted note.
assert.ok(!hasVibrato({ rateHz: 0, depthCents: 0, detected: false }), 'detected=false means no vibrato');
assert.ok(hasVibrato({ rateHz: 5.5, depthCents: 25, detected: true }), 'detected=true means vibrato');
// Legacy analyses have no `detected` field and must keep their old classification.
assert.deepStrictEqual(
  classifyVibratoFaults({ rateHz: 2.5, depthCents: 15, periodicityScore: 0.6, consistencyOk: true }),
  ['uneven'], 'legacy out-of-range rate still reports uneven');
console.log('PASS  detected flag round-trip + legacy fallback');

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll vibrato diagnosis tests passed.');
