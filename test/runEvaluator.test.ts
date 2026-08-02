/**
 * runEvaluator (exercise-take verification) tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/runEvaluator.test.ts
 */

import { runEvaluator } from '../src/lib/runEvaluator';
import type { PitchLandingEvaluatorParams, VibratoEvaluatorParams, RhythmEvaluatorParams } from '../src/lib/practiceBlocks';

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

// Same harmonic-tone synthesizer as test/audioCorpus.test.ts. Real pitch
// detection under-reads synthetic cents offsets (see that file's note), so
// these tests check structural behavior — segmentation into attempts, and
// pass/fail wiring — rather than exact cents/rate values.
function synthTone(freqHz: number, durS: number, sr = SR): Float32Array {
  const n = Math.floor(sr * durS);
  const out = new Float32Array(n);
  const harm = [1, 0.5, 0.33, 0.22, 0.14];
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.03) * Math.min(1, (durS - t) / 0.05);
    let v = 0;
    for (let h = 0; h < harm.length; h++) v += harm[h] * Math.sin(2 * Math.PI * freqHz * (h + 1) * t);
    out[i] = (0.5 * env * v) / 1.7;
  }
  return out;
}

function silence(durS: number, sr = SR): Float32Array {
  return new Float32Array(Math.floor(sr * durS));
}

function concat(parts: Float32Array[]): Float32Array {
  const total = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

// Frequency-modulated sine — a synthesized vibrato at a given rate/depth.
function synthVibratoTone(freqHz: number, durS: number, rateHz: number, depthCents: number, sr = SR): Float32Array {
  const n = Math.floor(sr * durS);
  const out = new Float32Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.03) * Math.min(1, (durS - t) / 0.05);
    const centsOffset = depthCents * Math.sin(2 * Math.PI * rateHz * t);
    const f = freqHz * Math.pow(2, centsOffset / 1200);
    phase += (2 * Math.PI * f) / sr;
    out[i] = 0.5 * env * Math.sin(phase);
  }
  return out;
}

function pitchParams(overrides: Partial<PitchLandingEvaluatorParams> = {}): PitchLandingEvaluatorParams {
  return { evaluatorId: 'pitchLanding', centsThreshold: 20, requiredStreak: 3, ...overrides };
}

function vibratoParams(overrides: Partial<VibratoEvaluatorParams> = {}): VibratoEvaluatorParams {
  return { evaluatorId: 'vibrato', requiredSuccesses: 1, minDurationSeconds: 0.5, ...overrides };
}

function rhythmParams(overrides: Partial<RhythmEvaluatorParams> = {}): RhythmEvaluatorParams {
  return { evaluatorId: 'rhythm', startBpm: 60, minBpm: 40, maxBpm: 120, beatCount: 3, toleranceMs: 100, requiredOnTimeFraction: 0.6, ...overrides };
}

// A longer, cleaner stand-in for the metronome's decaying 1kHz click (see
// useMetronome.ts's buildClickWav) — long enough to reliably clear
// MIN_ATTEMPT_FRAMES on its own, so this isolates the frequency-based
// exclusion in runEvaluator.ts rather than relying on duration filtering.
function synthClick(durS = 0.15, sr = SR): Float32Array {
  const n = Math.floor(sr * durS);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const env = Math.min(1, t / 0.01) * Math.min(1, (durS - t) / 0.02);
    out[i] = 0.6 * env * Math.sin(2 * Math.PI * 1000 * t);
  }
  return out;
}

// ── dispatch basics ──────────────────────────────────────────────────────────
{
  check(
    'no evaluator on the block → null (self-report fallback)',
    runEvaluator(undefined, { samples: silence(1), sampleRate: SR }) === null,
  );

  const noTake = runEvaluator(pitchParams(), null);
  check(
    'no captured take → unpassed with zero attempts',
    noTake !== null && noTake.passed === false && noTake.attempts === 0,
  );
}

// ── pitch landing: stop/start segmentation + pass/fail ──────────────────────
{
  // Four clean A4 attempts, each separated by a stop (silence > the attempt gap).
  const take = concat([
    synthTone(440, 0.4), silence(0.3),
    synthTone(440, 0.4), silence(0.3),
    synthTone(440, 0.4), silence(0.3),
    synthTone(440, 0.4),
  ]);
  const result = runEvaluator(pitchParams({ requiredStreak: 3 }), { samples: take, sampleRate: SR });
  check('four stop-start attempts segment into 4 attempts', result !== null && result.attempts === 4, `attempts=${result?.attempts}`);
  check('four clean in-tune attempts pass a 3-streak requirement', result !== null && result.passed === true, result?.feedback);
}

{
  // Only two attempts recorded — can never reach a streak of 4.
  const take = concat([synthTone(440, 0.4), silence(0.3), synthTone(440, 0.4)]);
  const result = runEvaluator(pitchParams({ requiredStreak: 4 }), { samples: take, sampleRate: SR });
  check(
    'two attempts cannot satisfy a streak of 4',
    result !== null && result.passed === false && result.bestStreak < 4,
    `bestStreak=${result?.bestStreak}`,
  );
}

{
  // Continuous tone with no stop should segment as one attempt, not many.
  const take = synthTone(440, 2.0);
  const result = runEvaluator(pitchParams(), { samples: take, sampleRate: SR });
  check('one continuous tone segments into 1 attempt', result !== null && result.attempts === 1, `attempts=${result?.attempts}`);
}

// ── vibrato: modulated vs. straight tone ─────────────────────────────────────
{
  const take = synthVibratoTone(440, 2.5, 5.5, 30);
  const result = runEvaluator(
    vibratoParams({ minRateHz: 3, maxRateHz: 8, minDepthCents: 5, requiredSuccesses: 1 }),
    { samples: take, sampleRate: SR },
  );
  check('a modulated tone yields at least one vibrato attempt', result !== null && result.attempts >= 1, `attempts=${result?.attempts}`);
}

{
  // A dead-straight tone (no modulation) should not pass a vibrato depth check.
  const take = synthTone(440, 2.5);
  const result = runEvaluator(vibratoParams({ requiredSuccesses: 1 }), { samples: take, sampleRate: SR });
  check('a straight tone does not pass a vibrato check', result !== null && result.passed === false);
}

// ── rhythm: the metronome's own click must not count as the player's note ───
{
  // Beats at 0s, 1s, 2s. Only the metronome's own click appears near each
  // beat — no real playing at all. Before the click-frequency filter, this
  // would misread as three perfectly-on-time hits.
  const take = concat([
    synthClick(), silence(1.0 - 0.15),
    synthClick(), silence(1.0 - 0.15),
    synthClick(), silence(0.3),
  ]);
  const result = runEvaluator(rhythmParams({ beatCount: 3 }), { samples: take, sampleRate: SR, beatTimestamps: [0, 1, 2] });
  check(
    'metronome click bleed alone is not counted as an on-time hit',
    result !== null && result.successCount === 0,
    `successCount=${result?.successCount}, feedback=${result?.feedback}`,
  );
}

{
  // A genuine note landing 20ms after the beat, with no click in this
  // fixture — confirms the filter doesn't also swallow real attempts.
  const take = concat([silence(1.02), synthTone(440, 0.3)]);
  const result = runEvaluator(rhythmParams({ beatCount: 1 }), { samples: take, sampleRate: SR, beatTimestamps: [1.0] });
  check(
    'a genuine note near the beat is still detected as an on-time attempt',
    result !== null && result.successCount === 1,
    `successCount=${result?.successCount}, feedback=${result?.feedback}`,
  );
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll runEvaluator checks passed');
