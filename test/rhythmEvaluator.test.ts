/**
 * rhythmEvaluator tests — click-track timing judge for the adaptive-tempo
 * "Metronome Grid Repair" drill.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/rhythmEvaluator.test.ts
 */

import { evaluateRhythm } from '../src/lib/rhythmEvaluator';
import type { RhythmAttempt } from '../src/lib/rhythmEvaluator';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function onTime(offsetMs = 10): RhythmAttempt {
  return { offsetMs, confidence: 0.8 };
}

const opts = { toleranceMs: 100, requiredOnTimeFraction: 0.75 };

// ── all clicks landed on time ────────────────────────────────────────────────
{
  const attempts = [onTime(), onTime(-20), onTime(30), onTime()];
  const result = evaluateRhythm(attempts, opts);
  check('all on-time clicks pass', result.passed === true, result.feedback);
  check('locked-in feedback when every click lands', result.feedback.includes('Locked'), result.feedback);
  check('attemptResults has one entry per click', result.attemptResults?.length === 4);
}

// ── exactly the required fraction passes ─────────────────────────────────────
{
  const attempts = [onTime(), onTime(), onTime(), { offsetMs: 400, confidence: 0.8 }];
  const result = evaluateRhythm(attempts, opts);
  check('3 of 4 on-time meets a 0.75 requirement', result.passed === true, result.feedback);
}

// ── below the required fraction fails, with progress-credit feedback ─────────
{
  const attempts = [onTime(), { offsetMs: 400, confidence: 0.8 }, { offsetMs: -350, confidence: 0.8 }, onTime()];
  const result = evaluateRhythm(attempts, opts);
  check('2 of 4 on-time fails a 0.75 requirement', result.passed === false);
  check('feedback credits the partial progress', /50%/.test(result.feedback), result.feedback);
}

// ── zero on-time clicks names the miss direction instead ─────────────────────
{
  const attempts = [{ offsetMs: 400, confidence: 0.8 }, { offsetMs: -350, confidence: 0.8 }];
  const result = evaluateRhythm(attempts, opts);
  check('0 of 2 on-time fails', result.passed === false);
  check('feedback names the miss direction', /ahead of|behind/.test(result.feedback), result.feedback);
}

// ── a missed click (no attack detected) counts as off-time, not a crash ──────
{
  const attempts = [onTime(), { offsetMs: null, confidence: 0 }, onTime(), onTime()];
  const result = evaluateRhythm(attempts, opts);
  check('a missed click still resolves without crashing', typeof result.passed === 'boolean');
  check('missed click is not counted as a success', result.successCount === 3);
}

// ── low-confidence detection near a click does not count as on-time ──────────
{
  const attempts = [{ offsetMs: 5, confidence: 0.1 }, onTime(), onTime(), onTime()];
  const result = evaluateRhythm(attempts, { ...opts, minConfidence: 0.45 });
  check('a low-confidence near-hit fails even though the offset is tiny', result.successCount === 3);
}

// ── empty take never passes ──────────────────────────────────────────────────
{
  const result = evaluateRhythm([], opts);
  check('no attempts at all does not pass', result.passed === false);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll rhythmEvaluator checks passed');
