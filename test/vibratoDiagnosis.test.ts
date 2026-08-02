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
  classifyVibratoFaults, hasVibrato, VIBRATO_DISPLAY,
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

if (failures > 0) {
  console.error(`\n${failures} case(s) failed`);
  process.exit(1);
}
console.log('\nAll vibrato diagnosis tests passed.');
