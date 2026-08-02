/**
 * dynamicsEvaluator tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/dynamicsEvaluator.test.ts
 */

import { evaluateDynamicsShape } from '../src/lib/dynamicsEvaluator';

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

function tone(dur: number, ampFn: (t: number) => number): Float32Array {
  const n = Math.floor(SR * dur);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    out[i] = ampFn(t) * Math.sin(2 * Math.PI * 440 * t);
  }
  return out;
}

// ── crescendo: amplitude ramps from quiet to loud ────────────────────────────
{
  const take = tone(2, (t) => 0.02 + 0.5 * (t / 2));
  const result = evaluateDynamicsShape(take, SR, { shape: 'crescendo', minRangeDb: 6 });
  check('a ramping-up tone passes a crescendo target', result.passed === true, result.feedback);
}

// ── diminuendo: amplitude ramps from loud to quiet ────────────────────────────
{
  const take = tone(2, (t) => 0.5 - 0.48 * (t / 2));
  const result = evaluateDynamicsShape(take, SR, { shape: 'diminuendo', minRangeDb: 6 });
  check('a ramping-down tone passes a diminuendo target', result.passed === true, result.feedback);
}

// ── steady tone fails a crescendo target ──────────────────────────────────────
{
  const take = tone(2, () => 0.3);
  const result = evaluateDynamicsShape(take, SR, { shape: 'crescendo', minRangeDb: 6 });
  check('a flat tone fails a crescendo target', result.passed === false);
}

// ── silence can't be judged ───────────────────────────────────────────────────
{
  const take = new Float32Array(Math.floor(SR * 1));
  const result = evaluateDynamicsShape(take, SR, { shape: 'steady' });
  check('silence yields zero attempts (unjudgeable)', result.attempts === 0 && result.passed === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll dynamicsEvaluator checks passed');
