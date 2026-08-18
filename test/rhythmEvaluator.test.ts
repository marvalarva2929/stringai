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
  check('feedback names the miss direction', /early|late/.test(result.feedback), result.feedback);
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

// ── the fitted offset: steadiness, not absolute phase ────────────────────────
//
// Every stage between the click firing and the note reaching the file adds delay
// in the same direction, and none of it is measured (grep "latency" across the
// app: nothing). Judging raw offsets against a window centred on zero made the
// only way to pass be to anticipate a constant the player cannot see.
{
  // A rock-steady 250ms behind the click. Deliberately well outside the 100ms
  // tolerance: without the offset fit every one of these beats fails, which is
  // precisely what made the metronome impossible to satisfy.
  const steadyLag = [250, 248, 252, 250, 251, 249].map((o) => ({ offsetMs: o, confidence: 0.8 }));
  const result = evaluateRhythm(steadyLag, opts);
  check('a steady 250ms lag passes', result.passed === true, result.feedback);
  check('all six beats count as on time', result.successCount === 6, `successCount=${result.successCount}`);
  check(
    'and the lag is reported rather than penalised',
    /250ms behind/.test(result.feedback),
    result.feedback,
  );
}

{
  // Alternating ±150ms: the same *mean* error as a player dead on the click, but
  // not steady. The fit must not rescue this.
  const jitter = [150, -150, 150, -150, 150, -150].map((o) => ({ offsetMs: o, confidence: 0.8 }));
  const result = evaluateRhythm(jitter, opts);
  check('alternating ±150ms fails', result.passed === false, result.feedback);
  check(
    'jitter is not rescued by the fit, unlike an equally large steady lag',
    result.successCount === 0,
    `successCount=${result.successCount}`,
  );
}

{
  // Too few attempts to tell a bias from simply being late — do not forgive it.
  const twoLate = [{ offsetMs: 300, confidence: 0.8 }, { offsetMs: 300, confidence: 0.8 }];
  const result = evaluateRhythm(twoLate, opts);
  check('two late attempts are not excused as a bias', result.passed === false, result.feedback);
}

{
  // Genuinely good playing must not be made worse by the correction.
  const tight = [5, -8, 3, 6, -4, 2].map((o) => ({ offsetMs: o, confidence: 0.8 }));
  const result = evaluateRhythm(tight, opts);
  check('tight playing still passes', result.passed === true, result.feedback);
  check('and a negligible bias is not mentioned', !/ms behind|ms ahead/.test(result.feedback), result.feedback);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll rhythmEvaluator checks passed');
