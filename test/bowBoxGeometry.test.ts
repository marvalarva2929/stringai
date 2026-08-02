/**
 * Bow-box geometry test harness.
 *
 *   node --experimental-strip-types --loader ./test/ts-resolver.mjs test/bowBoxGeometry.test.ts
 *   (or: npm run test:bowgeometry)
 *
 * Builds synthetic scenes with a known bow line and violin string line, wraps
 * them in bounding boxes the way the detector would, and checks that
 * deriveBowFrameFromBoxes recovers the frog/tip orientation, the contact
 * point, and the 0–1 bow-usage parameter (via the same projection formula
 * bowAnalysis.ts uses).
 */

import { createBowGeometryTracker, deriveBowFrameFromBoxes, lineIntersection } from '../src/lib/bowBoxGeometry';
import type { NormBox, NormPoint } from '../src/lib/bowBoxGeometry';

let failures = 0;

function check(name: string, cond: boolean, detail = '') {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function approx(a: number, b: number, tol = 0.02): boolean {
  return Math.abs(a - b) <= tol;
}

/** Tight bbox around two points. */
function boxAround(a: NormPoint, b: NormPoint): NormBox {
  return {
    x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
  };
}

/** Same projection formula as bowAnalysis.ts computeContactPoint. */
function projectU(frame: { tipX: number; tipY: number; frogX: number; frogY: number; contactX: number; contactY: number }): number {
  const dx = frame.tipX - frame.frogX;
  const dy = frame.tipY - frame.frogY;
  const len2 = dx * dx + dy * dy;
  const t = ((frame.contactX - frame.frogX) * dx + (frame.contactY - frame.frogY) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}

// ─────────────────────────────────────────────────────────────
// Scene: player facing camera (non-mirrored coords, top-left origin).
//
// Violin held on the player's left → appears on the RIGHT side of the frame
// in non-mirrored coords... but wrists are what matter, not sides. We place:
//   - bow from frog (0.7, 0.8) up-left to tip (0.2, 0.3)
//   - right wrist near the frog at (0.72, 0.83)
//   - violin string line from scroll (0.75, 0.35) to tailpiece (0.45, 0.6)
//   - left wrist near the scroll at (0.78, 0.33)
// True contact = intersection of the two lines.
// ─────────────────────────────────────────────────────────────

console.log('scene: mid-bow contact, everything visible');
{
  const frog: NormPoint = { x: 0.7, y: 0.8 };
  const tip: NormPoint = { x: 0.2, y: 0.3 };
  const scroll: NormPoint = { x: 0.75, y: 0.35 };
  const tail: NormPoint = { x: 0.45, y: 0.6 };

  const truth = lineIntersection(frog, tip, scroll, tail)!;
  check('scene sanity: contact on bow segment', truth.t > 0 && truth.t < 1, `t=${truth.t}`);
  check('scene sanity: contact on string segment', truth.s > 0 && truth.s < 1, `s=${truth.s}`);

  const frame = deriveBowFrameFromBoxes({
    timestamp: 1.0,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: boxAround(scroll, tail),
    rightWrist: { x: 0.72, y: 0.83 },
    leftWrist: { x: 0.78, y: 0.33 },
  });

  check('frame produced', frame !== null);
  if (frame) {
    check('frog at frog corner', approx(frame.frogX, frog.x) && approx(frame.frogY, frog.y),
      `got (${frame.frogX}, ${frame.frogY})`);
    check('tip at tip corner', approx(frame.tipX, tip.x) && approx(frame.tipY, tip.y),
      `got (${frame.tipX}, ${frame.tipY})`);
    check('all keypoints visible', frame.tipVisible && frame.frogVisible && frame.contactVisible);
    check('contact at line intersection',
      approx(frame.contactX, truth.point.x) && approx(frame.contactY, truth.point.y),
      `got (${frame.contactX.toFixed(3)}, ${frame.contactY.toFixed(3)}), want (${truth.point.x.toFixed(3)}, ${truth.point.y.toFixed(3)})`);
    check('bow-usage u matches ground truth', approx(projectU(frame), truth.t, 0.03),
      `u=${projectU(frame).toFixed(3)}, want ${truth.t.toFixed(3)}`);
  }
}

console.log('scene: violin diagonal disambiguation WITHOUT left wrist');
{
  const frog: NormPoint = { x: 0.7, y: 0.8 };
  const tip: NormPoint = { x: 0.2, y: 0.3 };
  const scroll: NormPoint = { x: 0.75, y: 0.35 };
  const tail: NormPoint = { x: 0.45, y: 0.6 };
  const truth = lineIntersection(frog, tip, scroll, tail)!;

  const frame = deriveBowFrameFromBoxes({
    timestamp: 1.0,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: boxAround(scroll, tail),
    rightWrist: { x: 0.72, y: 0.83 },
    leftWrist: null,
  });

  check('contact found without left wrist', frame !== null && frame.contactVisible);
  if (frame && frame.contactVisible) {
    check('contact still at intersection',
      approx(frame.contactX, truth.point.x) && approx(frame.contactY, truth.point.y),
      `got (${frame.contactX.toFixed(3)}, ${frame.contactY.toFixed(3)})`);
  }
}

console.log('scene: frog clipped at bottom frame edge');
{
  // Bow extends below the frame: the detector clips the box at y=1.
  const tip: NormPoint = { x: 0.25, y: 0.35 };
  const clippedFrog: NormPoint = { x: 0.72, y: 0.995 };

  const frame = deriveBowFrameFromBoxes({
    timestamp: 2.0,
    bowBox: boxAround(tip, clippedFrog),
    bowConfidence: 0.8,
    violinBox: { x1: 0.4, y1: 0.3, x2: 0.8, y2: 0.65 },
    rightWrist: { x: 0.75, y: 0.9 },
    leftWrist: { x: 0.82, y: 0.28 },
  });

  check('frame produced', frame !== null);
  if (frame) {
    check('frog marked NOT visible (triggers bowAnalysis fallback)', !frame.frogVisible);
    check('tip still visible', frame.tipVisible);
  }
}

console.log('scene: foreshortened bow (tiny box) is rejected');
{
  const frame = deriveBowFrameFromBoxes({
    timestamp: 3.0,
    bowBox: { x1: 0.5, y1: 0.5, x2: 0.58, y2: 0.56 },
    bowConfidence: 0.7,
    violinBox: { x1: 0.4, y1: 0.3, x2: 0.8, y2: 0.65 },
    rightWrist: { x: 0.6, y: 0.6 },
  });
  check('tiny bow box → null', frame === null);
}

console.log('scene: no right wrist → cannot orient → null');
{
  const frame = deriveBowFrameFromBoxes({
    timestamp: 4.0,
    bowBox: { x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.8 },
    bowConfidence: 0.9,
    violinBox: { x1: 0.4, y1: 0.3, x2: 0.8, y2: 0.65 },
    rightWrist: null,
  });
  check('missing right wrist → null', frame === null);
}

console.log('scene: no violin box → keypoints yes, contact no');
{
  const frame = deriveBowFrameFromBoxes({
    timestamp: 5.0,
    bowBox: { x1: 0.2, y1: 0.3, x2: 0.7, y2: 0.8 },
    bowConfidence: 0.9,
    violinBox: null,
    rightWrist: { x: 0.72, y: 0.83 },
  });
  check('frame produced', frame !== null);
  if (frame) {
    check('contact marked not visible', !frame.contactVisible);
    check('tip/frog still usable', frame.tipVisible && frame.frogVisible);
  }
}

console.log('scene: bow lifted off the string (no plausible intersection)');
{
  // Bow held horizontally ABOVE the violin: its line never crosses the
  // violin's string segment within tolerance.
  const frog: NormPoint = { x: 0.85, y: 0.15 };
  const tip: NormPoint = { x: 0.15, y: 0.1 };
  const frame = deriveBowFrameFromBoxes({
    timestamp: 6.0,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: { x1: 0.45, y1: 0.4, x2: 0.8, y2: 0.7 },
    rightWrist: { x: 0.87, y: 0.18 },
    leftWrist: { x: 0.82, y: 0.38 },
  });
  check('frame produced', frame !== null);
  if (frame) {
    check('lifted bow → contact not visible', !frame.contactVisible);
  }
}

console.log('scene: frog/tip orientation follows the right wrist');
{
  // Same box, wrist near the OTHER end → frog and tip swap.
  const a: NormPoint = { x: 0.2, y: 0.3 };
  const b: NormPoint = { x: 0.7, y: 0.8 };
  const frame = deriveBowFrameFromBoxes({
    timestamp: 7.0,
    bowBox: boxAround(a, b),
    bowConfidence: 0.9,
    violinBox: null,
    rightWrist: { x: 0.18, y: 0.28 },  // near corner a this time
  });
  check('frame produced', frame !== null);
  if (frame) {
    check('frog now at corner a', approx(frame.frogX, a.x) && approx(frame.frogY, a.y));
    check('tip now at corner b', approx(frame.tipX, b.x) && approx(frame.tipY, b.y));
  }
}

// ─────────────────────────────────────────────────────────────
// Regression: the diagonals must be decided ONCE and kept.
//
// Two ways they used to flip mid-session, both reproduced here:
//   1. The violin's string diagonal was re-derived every frame by crossDiagonal,
//      which reads the bow's slope SIGN. A bow sweeping through vertical changes
//      that sign, so the string diagonal jumped to the other diagonal.
//   2. The bow's frog corner was the corner nearest the right wrist, recomputed
//      per frame, so wrist jitter could hop it to the other corner and invert
//      the bow axis.
// The tracker locks both, so neither can move once voted.
// ─────────────────────────────────────────────────────────────

console.log('scene: bow sweeps through vertical — string diagonal must not flip');
{
  const scroll: NormPoint = { x: 0.75, y: 0.35 };
  const tail: NormPoint = { x: 0.45, y: 0.6 };
  const violinBox = boxAround(scroll, tail);
  const tracker = createBowGeometryTracker();

  // The bow rotates about a pivot on the strings, from leaning one way, through
  // vertical, to leaning the other way — i.e. its slope sign changes sign.
  const pivot: NormPoint = { x: 0.6, y: 0.475 };
  const angles = [-60, -30, -5, 0, 5, 30, 60].map((d) => (d * Math.PI) / 180);

  const strings: string[] = [];
  let slopeSignsSeen = new Set<boolean>();

  for (let i = 0; i < angles.length; i++) {
    // Repeat each pose enough times to get past the lock sample on the first one.
    const reps = i === 0 ? 20 : 1;
    for (let r = 0; r < reps; r++) {
      const a = angles[i];
      const frog: NormPoint = { x: pivot.x + 0.28 * Math.sin(a), y: pivot.y + 0.28 * Math.cos(a) };
      const tip: NormPoint = { x: pivot.x - 0.28 * Math.sin(a), y: pivot.y - 0.28 * Math.cos(a) };
      slopeSignsSeen.add((tip.x - frog.x) * (tip.y - frog.y) > 0);

      const out = tracker.push({
        timestamp: i * 0.1 + r * 0.001,
        bowBox: boxAround(frog, tip),
        bowConfidence: 0.9,
        violinBox,
        rightWrist: { x: frog.x + 0.02, y: frog.y + 0.03 },
        leftWrist: { x: 0.78, y: 0.33 },
      });
      if (r === reps - 1 && out.string) {
        strings.push(`${out.string.a.x.toFixed(3)},${out.string.a.y.toFixed(3)}`);
      }
    }
  }

  check('scene sanity: bow slope sign actually flipped', slopeSignsSeen.size === 2,
    'the rotation must cross vertical or the test proves nothing');
  check('string diagonal identical on every frame', new Set(strings).size === 1,
    `saw ${new Set(strings).size} distinct scroll ends: ${[...new Set(strings)].join(' | ')}`);
}

console.log('scene: wrist jitter must not flip the locked bow axis');
{
  const frog: NormPoint = { x: 0.7, y: 0.8 };
  const tip: NormPoint = { x: 0.2, y: 0.3 };
  const bowBox = boxAround(frog, tip);
  const tracker = createBowGeometryTracker();

  // Lock in the true orientation (wrist by the frog).
  for (let i = 0; i < 20; i++) {
    tracker.push({
      timestamp: i * 0.05,
      bowBox,
      bowConfidence: 0.9,
      rightWrist: { x: 0.72, y: 0.83 },
    });
  }

  // Now a bad frame: the wrist reads nearer the TIP corner. Pre-lock this would
  // have swapped frog and tip and inverted the axis.
  const out = tracker.push({
    timestamp: 1.5,
    bowBox,
    bowConfidence: 0.9,
    rightWrist: { x: 0.18, y: 0.28 },
  });

  check('frame produced', out.bowFrame !== null);
  if (out.bowFrame) {
    check('frog stays at the locked corner despite jitter',
      approx(out.bowFrame.frogX, frog.x) && approx(out.bowFrame.frogY, frog.y),
      `got (${out.bowFrame.frogX.toFixed(3)}, ${out.bowFrame.frogY.toFixed(3)})`);
    check('tip stays at the locked corner despite jitter',
      approx(out.bowFrame.tipX, tip.x) && approx(out.bowFrame.tipY, tip.y));
  }
}

console.log('scene: violin box is held across frames where the detector misses it');
{
  const scroll: NormPoint = { x: 0.75, y: 0.35 };
  const tail: NormPoint = { x: 0.45, y: 0.6 };
  const frog: NormPoint = { x: 0.7, y: 0.8 };
  const tip: NormPoint = { x: 0.2, y: 0.3 };
  const tracker = createBowGeometryTracker();

  const seen = tracker.push({
    timestamp: 0,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: boxAround(scroll, tail),
    rightWrist: { x: 0.72, y: 0.83 },
    leftWrist: { x: 0.78, y: 0.33 },
  });
  check('string line present when the violin is detected', seen.string !== null);

  // Next frame: detector found no violin. The line must persist (violin is static).
  const missed = tracker.push({
    timestamp: 0.1,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: null,
    rightWrist: { x: 0.72, y: 0.83 },
    leftWrist: { x: 0.78, y: 0.33 },
  });
  check('string line survives a frame with no violin detection', missed.string !== null);
  check('contact still resolves on the held violin box', missed.bowFrame?.contactVisible === true);

  // Long after the hold window, it should lapse rather than go stale forever.
  const stale = tracker.push({
    timestamp: 60,
    bowBox: boxAround(frog, tip),
    bowConfidence: 0.9,
    violinBox: null,
    rightWrist: { x: 0.72, y: 0.83 },
    leftWrist: { x: 0.78, y: 0.33 },
  });
  check('held violin box expires after the hold window', stale.string === null);
}

console.log('');
if (failures > 0) {
  console.error(`${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('All bow-box geometry checks passed.');
