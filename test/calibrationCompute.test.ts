/**
 * calibrationCompute tests.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/calibrationCompute.test.ts
 */

import { computeCalibration, isCalibrationError } from '../src/lib/calibrationCompute';
import { deriveBowTimeSeries, applyCalibration } from '../src/lib/bowAnalysis';
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

// A fixed bow diagonal, well inside the frame (no edge clipping). frog is the
// bottom-left corner of the box, tip the top-right — consistent across every
// frame so lockFrogCorner locks onto the same corner every time.
const FROG = { x: 0.15, y: 0.75 };
const TIP = { x: 0.85, y: 0.25 };

function pointAtFraction(f: number): { x: number; y: number } {
  return { x: FROG.x + f * (TIP.x - FROG.x), y: FROG.y + f * (TIP.y - FROG.y) };
}

// `bowFraction` = where the contact sits along frog→tip (bowContactPoint's raw
// reading); `stringFraction` = the RawBowFrame.stringPosS value directly
// (fingerboard=0, bridge=1) — the two axes are independent by construction.
function makeClip(n: number, bowFraction: number, stringFraction: number, jitter = 0.01): RawBowFrame[] {
  const out: RawBowFrame[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i % 2 === 0 ? jitter : -jitter);
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

function makeClippedClip(n: number, bowFraction: number, stringFraction: number, jitter = 0.01): RawBowFrame[] {
  const edgeFrog = { x: 0, y: 0.9 };
  const edgeTip = { x: 1, y: 0.1 };
  const out: RawBowFrame[] = [];
  for (let i = 0; i < n; i++) {
    const j = (i % 2 === 0 ? jitter : -jitter);
    const f = Math.max(0, Math.min(1, bowFraction + j));
    out.push({
      timestamp: i * 0.1,
      tipX: edgeTip.x, tipY: edgeTip.y, tipVisible: false,
      frogX: edgeFrog.x, frogY: edgeFrog.y, frogVisible: false,
      contactX: edgeFrog.x + f * (edgeTip.x - edgeFrog.x),
      contactY: edgeFrog.y + f * (edgeTip.y - edgeFrog.y),
      contactVisible: true,
      confidence: 0.9,
      stringPosS: Math.max(0, Math.min(1, stringFraction + j)),
    });
  }
  return out;
}

// ── happy path: two well-separated positions produce a valid calibration ────
{
  // Position 1: bow near the tip (bowFraction≈0.85), contact near the bridge (stringFraction≈0.85)
  const bridgeTipClip = makeClip(15, 0.85, 0.85);
  // Position 2: bow near the frog (bowFraction≈0.15), contact near the fingerboard (stringFraction≈0.15)
  const fingerboardFrogClip = makeClip(15, 0.15, 0.15);
  const result = computeCalibration(bridgeTipClip, fingerboardFrogClip);

  check('valid clips produce a calibration, not an error', !isCalibrationError(result), isCalibrationError(result) ? result.error : '');
  if (!isCalibrationError(result)) {
    check('tipFraction near 0.85', Math.abs(result.tipFraction - 0.85) < 0.05, `tipFraction=${result.tipFraction}`);
    check('frogFraction near 0.15', Math.abs(result.frogFraction - 0.15) < 0.05, `frogFraction=${result.frogFraction}`);
    check('bridgeFraction near 0.85', Math.abs(result.bridgeFraction - 0.85) < 0.05, `bridgeFraction=${result.bridgeFraction}`);
    check('fingerboardFraction near 0.15', Math.abs(result.fingerboardFraction - 0.15) < 0.05, `fingerboardFraction=${result.fingerboardFraction}`);
    check('calibratedAt is a recent timestamp', Math.abs(Date.now() - result.calibratedAt) < 5000);

    // ── applyCalibration rescales a raw reading against these fractions ──────
    // A raw contact-point reading that landed at the true dead-space-affected
    // "0.15..0.85" sub-range should rescale to the full [0,1] the exercises need.
    const rawSeries = deriveBowTimeSeries(makeClip(5, 0.5, 0.5, 0)); // dead-center raw reading
    const calibrated = applyCalibration(rawSeries, result);
    const midCp = calibrated.bowContactPoint.points[2]?.v;
    check('a raw mid-range reading rescales to ~0.5 (already centered in the calibrated range)', midCp !== null && midCp !== undefined && Math.abs(midCp - 0.5) < 0.1, `midCp=${midCp}`);
    check('calibrated series reports calibrated=true', calibrated.calibrated === true);
    check('uncalibrated series reports calibrated=false', rawSeries.calibrated === false);
  }
}

// ── calibration can use a visible bow segment even when both endpoints clip ─
{
  const bridgeTipClip = makeClippedClip(15, 0.85, 0.85);
  const fingerboardFrogClip = makeClippedClip(15, 0.15, 0.15);
  const result = computeCalibration(bridgeTipClip, fingerboardFrogClip);
  check('clipped endpoints still produce calibration when bow/contact are visible', !isCalibrationError(result), isCalibrationError(result) ? result.error : '');
}

// ── too few qualifying samples ────────────────────────────────────────────────
{
  const tooShort = makeClip(3, 0.85, 0.85);
  const fingerboardFrogClip = makeClip(15, 0.15, 0.15);
  const result = computeCalibration(tooShort, fingerboardFrogClip);
  check('too few samples in position 1 → error', isCalibrationError(result), isCalibrationError(result) ? result.error : 'unexpectedly succeeded');
}

// ── clipped/low-confidence frames don't count toward the qualifying bar ─────
{
  const lowConfidence = makeClip(15, 0.85, 0.85).map((f) => ({ ...f, confidence: 0.1 }));
  const fingerboardFrogClip = makeClip(15, 0.15, 0.15);
  const result = computeCalibration(lowConfidence, fingerboardFrogClip);
  check('all-low-confidence clip → error', isCalibrationError(result), isCalibrationError(result) ? result.error : 'unexpectedly succeeded');
}

// ── degenerate: both positions read almost the same fraction ────────────────
{
  const samePosition1 = makeClip(15, 0.5, 0.5);
  const samePosition2 = makeClip(15, 0.52, 0.5);
  const result = computeCalibration(samePosition1, samePosition2);
  check('near-identical positions → degenerate error', isCalibrationError(result), isCalibrationError(result) ? result.error : 'unexpectedly succeeded');
}

if (failures > 0) {
  console.error(`\n${failures} check(s) failed`);
  process.exit(1);
}
console.log('\nAll calibrationCompute checks passed');
