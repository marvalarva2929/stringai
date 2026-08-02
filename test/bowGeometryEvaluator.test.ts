/**
 * bowGeometryEvaluator tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/bowGeometryEvaluator.test.ts
 */

import { evaluateBowGeometry } from '../src/lib/bowGeometryEvaluator';
import { computeCalibration, isCalibrationError } from '../src/lib/calibrationCompute';
import type { RawBowFrame } from '../src/types/signals';

let failures = 0;
function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const FROG = { x: 0.15, y: 0.75 };
const TIP = { x: 0.85, y: 0.25 };

function pointAtFraction(f: number) {
  return { x: FROG.x + f * (TIP.x - FROG.x), y: FROG.y + f * (TIP.y - FROG.y) };
}

function makeClip(n: number, bowFraction: number, stringFraction: number, jitter = 0.01): RawBowFrame[] {
  const out: RawBowFrame[] = [];
  for (let i = 0; i < n; i++) {
    const j = i % 2 === 0 ? jitter : -jitter;
    const contact = pointAtFraction(Math.max(0, Math.min(1, bowFraction + j)));
    out.push({
      timestamp: i * 0.1,
      tipX: TIP.x, tipY: TIP.y, tipVisible: true,
      frogX: FROG.x, frogY: FROG.y, frogVisible: true,
      contactX: contact.x, contactY: contact.y, contactVisible: true,
      confidence: 0.9,
      stringPosS: Math.max(0, Math.min(1, stringFraction + j)),
    });
  }
  return out;
}

const calibration = (() => {
  const result = computeCalibration(makeClip(15, 0.85, 0.85), makeClip(15, 0.15, 0.15));
  if (isCalibrationError(result)) throw new Error('test setup: calibration should succeed');
  return result;
})();

// ── bowAngle: doesn't need calibration ───────────────────────────────────────
{
  const straight = makeClip(15, 0.5, 0.5, 0); // frog/tip fixed → angle constant
  const result = evaluateBowGeometry(straight, null, { signal: 'bowAngle', minValue: -90, maxValue: 90, requiredGoodFraction: 0.7 });
  check('bowAngle works without calibration', result.passed === true, result.feedback);
}

// ── stringPos / bowDistribution: require calibration ─────────────────────────
{
  const clip = makeClip(15, 0.5, 0.5);
  const stringResult = evaluateBowGeometry(clip, null, { signal: 'stringPos', minValue: 0, maxValue: 1, requiredGoodFraction: 0.7 });
  check('stringPos without calibration → blocked, zero attempts', stringResult.passed === false && stringResult.attempts === 0);

  const distResult = evaluateBowGeometry(clip, null, { signal: 'bowDistribution', minRobustRange: 0.5 });
  check('bowDistribution without calibration → blocked, zero attempts', distResult.passed === false && distResult.attempts === 0);
}

// ── stringPos with calibration: a mid-range reading passes a wide lane ───────
{
  const clip = makeClip(15, 0.5, 0.5);
  const result = evaluateBowGeometry(clip, calibration, { signal: 'stringPos', minValue: 0.3, maxValue: 0.7, requiredGoodFraction: 0.7 });
  check('calibrated mid-range stringPos passes a wide lane target', result.passed === true, result.feedback);
}

// ── bowDistribution: full-bow sweep passes, narrow sweep fails ───────────────
{
  const wideSweep = [
    ...makeClip(10, 0.1, 0.5),
    ...makeClip(10, 0.5, 0.5),
    ...makeClip(10, 0.9, 0.5),
  ];
  const wideResult = evaluateBowGeometry(wideSweep, calibration, { signal: 'bowDistribution', minRobustRange: 0.5 });
  check('a full frog-to-tip sweep passes a distribution target', wideResult.passed === true, wideResult.feedback);

  const narrowSweep = makeClip(30, 0.5, 0.5, 0.02);
  const narrowResult = evaluateBowGeometry(narrowSweep, calibration, { signal: 'bowDistribution', minRobustRange: 0.5 });
  check('a narrow mid-bow sweep fails a distribution target', narrowResult.passed === false, narrowResult.feedback);
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll bowGeometryEvaluator checks passed');
