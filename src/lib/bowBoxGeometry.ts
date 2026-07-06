import type { RawBowFrame } from '../types/signals';

// ─────────────────────────────────────────────────────────────
// Bow-box geometry: 2-class detector boxes → RawBowFrame
//
// The on-device model detects two bounding boxes (bow, violin) instead of
// keypoints. This module reconstructs the three pseudo-keypoints the rest of
// the pipeline expects (tip, frog, contact — see bowAnalysis.ts):
//
//   • The bow stick runs corner-to-corner along one diagonal of its tight
//     bbox. The frog is at the player's right hand, so the frog corner is the
//     bow-box corner nearest the right wrist; the tip is the opposite corner.
//   • The violin strings run along one diagonal of the violin bbox (scroll
//     end nearest the left wrist, which holds the neck).
//   • The contact point — where the bow crosses the strings — is the
//     intersection of those two diagonals.
//
// All coordinates are normalized [0,1], top-left origin, NON-mirrored — the
// same space as the raw native joints (PoseCameraModule) and the detector
// boxes. Do not pass mirrored/scoring-space landmarks in here.
// ─────────────────────────────────────────────────────────────

export interface NormBox { x1: number; y1: number; x2: number; y2: number; }
export interface NormPoint { x: number; y: number; }

export interface BowBoxFrameInput {
  timestamp: number;
  bowBox: NormBox;
  bowConfidence: number;
  violinBox?: NormBox | null;
  /** Right wrist (bow hand) in raw frame coords — required to orient the bow. */
  rightWrist?: NormPoint | null;
  /** Left wrist (violin hand) — optional, orients the violin string diagonal. */
  leftWrist?: NormPoint | null;
}

// A bow-box diagonal shorter than this (normalized) means the bow is heavily
// foreshortened (pointing at the camera) or the detection is spurious — the
// diagonal direction is meaningless, so the frame is dropped.
const MIN_BOW_DIAGONAL = 0.15;

// A corner within this distance of a frame edge is treated as clipped: the
// real endpoint is likely outside the frame, so the corner is a truncation
// artifact, not the true tip/frog. bowAnalysis.ts falls back to last-known
// bow geometry when frogVisible is false.
const EDGE_MARGIN = 0.02;

// Intersection tolerance: the contact must lie on the bow segment (t) and on
// the violin string segment (s), with slack for box noise.
const BOW_SEG_MARGIN = 0.05;
const VIOLIN_SEG_MARGIN = 0.1;

function dist2(a: NormPoint, b: NormPoint): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

function corners(box: NormBox): NormPoint[] {
  return [
    { x: box.x1, y: box.y1 },
    { x: box.x1, y: box.y2 },
    { x: box.x2, y: box.y1 },
    { x: box.x2, y: box.y2 },
  ];
}

function nearestCorner(box: NormBox, p: NormPoint): NormPoint {
  return corners(box).reduce((a, b) => (dist2(a, p) <= dist2(b, p) ? a : b));
}

function oppositeCorner(box: NormBox, c: NormPoint): NormPoint {
  return { x: box.x1 + box.x2 - c.x, y: box.y1 + box.y2 - c.y };
}

function isClipped(p: NormPoint): boolean {
  return (
    p.x < EDGE_MARGIN || p.x > 1 - EDGE_MARGIN ||
    p.y < EDGE_MARGIN || p.y > 1 - EDGE_MARGIN
  );
}

/**
 * Intersection of lines a1→a2 and b1→b2.
 * Returns parametric positions (t along a, s along b) and the point, or null
 * when the lines are near-parallel.
 */
export function lineIntersection(
  a1: NormPoint, a2: NormPoint,
  b1: NormPoint, b2: NormPoint,
): { t: number; s: number; point: NormPoint } | null {
  const dax = a2.x - a1.x, day = a2.y - a1.y;
  const dbx = b2.x - b1.x, dby = b2.y - b1.y;
  const denom = dax * dby - day * dbx;
  if (Math.abs(denom) < 1e-9) return null;
  const t = ((b1.x - a1.x) * dby - (b1.y - a1.y) * dbx) / denom;
  const s = ((b1.x - a1.x) * day - (b1.y - a1.y) * dax) / denom;
  return { t, s, point: { x: a1.x + t * dax, y: a1.y + t * day } };
}

/**
 * Find the bow/string contact point: intersection of the frog→tip line with
 * the violin-box string diagonal.
 *
 * When the left wrist is known, the string diagonal is oriented from the
 * scroll corner (nearest the left wrist) to the opposite corner. Otherwise
 * both diagonals are tried and the geometrically plausible one wins: the
 * intersection must lie on both segments, and ties go to the candidate whose
 * intersection is nearest the middle of the string line (the bow normally
 * plays between bridge and fingerboard end, not at the instrument's extremes).
 */
function findContact(
  frog: NormPoint,
  tip: NormPoint,
  violinBox: NormBox,
  leftWrist: NormPoint | null | undefined,
): { point: NormPoint; stringPosS: number | null } | null {
  // stringPosS is only meaningful when the wrist orients the diagonal
  // (0 = scroll end, 1 = tailpiece/bridge end); with the two-diagonal guess
  // the parameter's direction is ambiguous, so it is withheld.
  const oriented = !!leftWrist;
  let diagonals: Array<[NormPoint, NormPoint]>;
  if (leftWrist) {
    const scroll = nearestCorner(violinBox, leftWrist);
    diagonals = [[scroll, oppositeCorner(violinBox, scroll)]];
  } else {
    diagonals = [
      [{ x: violinBox.x1, y: violinBox.y1 }, { x: violinBox.x2, y: violinBox.y2 }],
      [{ x: violinBox.x1, y: violinBox.y2 }, { x: violinBox.x2, y: violinBox.y1 }],
    ];
  }

  let best: { point: NormPoint; midDist: number; s: number } | null = null;
  for (const [d1, d2] of diagonals) {
    const hit = lineIntersection(frog, tip, d1, d2);
    if (!hit) continue;
    const { t, s, point } = hit;
    if (t < -BOW_SEG_MARGIN || t > 1 + BOW_SEG_MARGIN) continue;
    if (s < -VIOLIN_SEG_MARGIN || s > 1 + VIOLIN_SEG_MARGIN) continue;
    const midDist = Math.abs(s - 0.5);
    if (!best || midDist < best.midDist) best = { point, midDist, s };
  }
  if (!best) return null;
  return { point: best.point, stringPosS: oriented ? best.s : null };
}

/**
 * Derive a RawBowFrame (tip/frog/contact pseudo-keypoints) from the 2-class
 * detector output plus wrist landmarks.
 *
 * Returns null when the frame carries no usable bow geometry:
 *   - no right wrist (cannot tell frog end from tip end)
 *   - bow box too short (foreshortened or spurious)
 *
 * Downstream (bowAnalysis.ts deriveBowTimeSeries) consumes the result
 * unchanged: the projection formula, frog-off-camera fallback, and spike
 * rejection all behave exactly as they did with model-emitted keypoints.
 */
export function deriveBowFrameFromBoxes(input: BowBoxFrameInput): RawBowFrame | null {
  const { bowBox, rightWrist } = input;
  if (!rightWrist) return null;

  const frog = nearestCorner(bowBox, rightWrist);
  const tip = oppositeCorner(bowBox, frog);
  if (Math.sqrt(dist2(frog, tip)) < MIN_BOW_DIAGONAL) return null;

  // A clipped corner means the true endpoint is off-frame — mark it invisible
  // so bowAnalysis.ts uses its last-known-geometry fallback instead of the
  // truncated corner. (Common for the frog during down-bows.)
  const frogVisible = !isClipped(frog);
  const tipVisible = !isClipped(tip);

  const contact = input.violinBox
    ? findContact(frog, tip, input.violinBox, input.leftWrist)
    : null;

  return {
    timestamp: input.timestamp,
    tipX: tip.x, tipY: tip.y, tipVisible,
    frogX: frog.x, frogY: frog.y, frogVisible,
    contactX: contact?.point.x ?? 0, contactY: contact?.point.y ?? 0,
    contactVisible: contact !== null,
    confidence: input.bowConfidence,
    stringPosS: contact?.stringPosS ?? undefined,
  };
}
