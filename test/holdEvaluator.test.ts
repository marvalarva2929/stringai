/**
 * holdEvaluator tests — confirms the "3 separate stopped holds" bug fix
 * (previously required an impossible in-take streak of 3 attempts).
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/holdEvaluator.test.ts
 */

import { evaluateHold } from '../src/lib/holdEvaluator';
import type { HoldAttempt } from '../src/lib/holdEvaluator';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function steadyHold(overrides: Partial<HoldAttempt> = {}): HoldAttempt {
  return { durationSeconds: 6, fractionInTolerance: 0.95, meanCentsDeviation: 2, confidence: 0.8, ...overrides };
}

const opts = { centsThreshold: 15, minDurationSeconds: 6, minFractionInTolerance: 0.75, requiredSuccesses: 3 };

// ── the bug: 3 separate holds (not one long streak) now passes ──────────────
{
  const attempts = [steadyHold(), steadyHold(), steadyHold()];
  const result = evaluateHold(attempts, opts);
  check('3 separate steady holds pass', result.passed === true, result.feedback);
  check('clean holds get warm feedback', result.feedback === 'Nice, that held steady!', result.feedback);
  check('attemptResults has one entry per hold', result.attemptResults?.length === 3);
}

// ── a single attempt (old bug scenario) correctly does not pass on its own ──
{
  const result = evaluateHold([steadyHold()], opts);
  check('a single hold alone does not satisfy requiredSuccesses=3', result.passed === false);
}

// ── too short a hold fails, with a specific message ──────────────────────────
{
  const attempts = [steadyHold({ durationSeconds: 2 }), steadyHold(), steadyHold()];
  const result = evaluateHold(attempts, opts);
  check('a too-short hold blocks the pass', result.passed === false);
  check('feedback names the duration problem', /too short/i.test(result.feedback), result.feedback);
}

// ── a drifted hold fails with a directional message ──────────────────────────
{
  const attempts = [steadyHold({ fractionInTolerance: 0.2, meanCentsDeviation: -22 }), steadyHold(), steadyHold()];
  const result = evaluateHold(attempts, opts);
  check('a wobbly hold blocks the pass', result.passed === false);
  check('feedback names the flat direction and magnitude', /flat by ~22/i.test(result.feedback), result.feedback);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll holdEvaluator checks passed');
