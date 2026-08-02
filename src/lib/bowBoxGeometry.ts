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

// Box corner ids: 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
// The two diagonals of an axis-aligned box are {0,3} and {1,2}, so the opposite
// corner is always `3 - id`, and a corner id names a diagonal *and* its orientation.
export function cornerAt(box: NormBox, id: number): NormPoint {
  switch (id) {
    case 0: return { x: box.x1, y: box.y1 };
    case 1: return { x: box.x2, y: box.y1 };
    case 2: return { x: box.x1, y: box.y2 };
    default: return { x: box.x2, y: box.y2 };
  }
}

export const oppositeId = (id: number) => 3 - id;

export function nearestCornerId(box: NormBox, p: NormPoint): number {
  let best = 0;
  let bestD = Infinity;
  for (let id = 0; id < 4; id++) {
    const d = dist2(cornerAt(box, id), p);
    if (d < bestD) { bestD = d; best = id; }
  }
  return best;
}

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

export function nearestCorner(box: NormBox, p: NormPoint): NormPoint {
  return corners(box).reduce((a, b) => (dist2(a, p) <= dist2(b, p) ? a : b));
}

export function oppositeCorner(box: NormBox, c: NormPoint): NormPoint {
  return { x: box.x1 + box.x2 - c.x, y: box.y1 + box.y2 - c.y };
}

export function isClipped(p: NormPoint): boolean {
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
 * Pick the violin box diagonal that CROSSES the bow (forms the "X" at the
 * contact), returned as [scroll end, bridge end].
 *
 * A box has two diagonals with opposite slope signs. The bow lies on its own
 * diagonal with some slope sign; the string diagonal that crosses it at the
 * widest angle is always the one with the OPPOSITE slope sign (for boxes at
 * angles α, β in (0°,90°), the opposite-sign pairing subtends α+β, the same-
 * sign pairing subtends |α−β| — the former is always larger). This is robust
 * where the old "corner nearest the left wrist" rule failed: that could land on
 * the diagonal roughly parallel to the bow (the wrong side).
 *
 * The left wrist, when known, only ORIENTS the result (scroll end = the end
 * nearest the wrist / neck) so stringPosS keeps its 0 = scroll, 1 = bridge
 * meaning. It no longer chooses which diagonal.
 */
export function crossDiagonal(
  frog: NormPoint,
  tip: NormPoint,
  box: NormBox,
  leftWrist: NormPoint | null | undefined,
): [NormPoint, NormPoint] {
  // Bow slope sign in image coords (y down): >0 = the TL→BR diagonal.
  const bowPositive = (tip.x - frog.x) * (tip.y - frog.y) > 0;
  // Cross diagonal = opposite slope sign.
  const [e1, e2]: [NormPoint, NormPoint] = bowPositive
    ? [{ x: box.x2, y: box.y1 }, { x: box.x1, y: box.y2 }]  // TR→BL (negative slope)
    : [{ x: box.x1, y: box.y1 }, { x: box.x2, y: box.y2 }]; // TL→BR (positive slope)
  // Orient so the scroll end (nearest the left wrist) comes first.
  if (leftWrist && dist2(e2, leftWrist) < dist2(e1, leftWrist)) return [e2, e1];
  return [e1, e2];
}

/**
 * Find the bow/string contact point: intersection of the frog→tip line with
 * the violin's cross-side string diagonal (see crossDiagonal). Returns null if
 * the intersection doesn't lie on both segments (e.g. the bow is lifted off the
 * strings). stringPosS (0 = scroll, 1 = bridge) is reported only when the left
 * wrist oriented the diagonal.
 */
function findContact(
  frog: NormPoint,
  tip: NormPoint,
  violinBox: NormBox,
  leftWrist: NormPoint | null | undefined,
): { point: NormPoint; stringPosS: number | null } | null {
  const diagonal = crossDiagonal(frog, tip, violinBox, leftWrist);
  return contactOnDiagonal(frog, tip, diagonal, leftWrist != null);
}

/** Intersect the bow with an already-chosen string diagonal [scroll, bridge]. */
function contactOnDiagonal(
  frog: NormPoint,
  tip: NormPoint,
  [d1, d2]: [NormPoint, NormPoint],
  oriented: boolean,
): { point: NormPoint; stringPosS: number | null } | null {
  const hit = lineIntersection(frog, tip, d1, d2);
  if (!hit) return null;
  const { t, s, point } = hit;
  if (t < -BOW_SEG_MARGIN || t > 1 + BOW_SEG_MARGIN) return null;
  if (s < -VIOLIN_SEG_MARGIN || s > 1 + VIOLIN_SEG_MARGIN) return null;
  return { point, stringPosS: oriented ? s : null };
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
  return finishBowFrame(input, frog, tip);
}

function finishBowFrame(
  input: BowBoxFrameInput,
  frog: NormPoint,
  tip: NormPoint,
  /** A locked string diagonal (already oriented scroll → bridge), from the tracker. */
  locked?: { diagonal: [NormPoint, NormPoint]; oriented: boolean } | null,
): RawBowFrame {

  // A clipped corner means the true endpoint is off-frame — mark it invisible
  // so bowAnalysis.ts uses its last-known-geometry fallback instead of the
  // truncated corner. (Common for the frog during down-bows.)
  const frogVisible = !isClipped(frog);
  const tipVisible = !isClipped(tip);

  // A locked string diagonal wins when supplied; otherwise fall back to
  // re-deriving it from this frame's bow slope (the unlocked, legacy path).
  const contact = locked
    ? contactOnDiagonal(frog, tip, locked.diagonal, locked.oriented)
    : input.violinBox
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

// ─────────────────────────────────────────────────────────────
// Stateful tracker: both diagonals are decided ONCE, then kept
//
// deriveBowFrameFromBoxes above is pure and re-derives both diagonals on every
// frame, which lets them flip mid-session:
//
//   • the bow's frog corner is whichever corner is nearest the right wrist, so
//     wrist jitter can hop it to the other corner and invert the bow axis;
//   • crossDiagonal picks the violin's string diagonal from the bow's slope
//     SIGN, which flips every time the bow rotates through vertical/horizontal —
//     so the string line jumps between the two diagonals while simply playing.
//
// The tracker votes over the first LOCK_SAMPLE usable frames, then freezes both
// corner ids for the rest of the session. Before the lock it uses the running
// modal vote, so geometry is available from frame one. Corner *ids* are locked
// rather than points, so the diagonals still track the boxes as they move —
// only the choice of WHICH diagonal is frozen.
//
// The violin is near-stationary but the detector only clears threshold on a
// minority of frames, so the last violin box is held for VIOLIN_HOLD_SECONDS.
// That keeps the string line drawn continuously instead of strobing.
// ─────────────────────────────────────────────────────────────

const LOCK_SAMPLE = 15;
const VIOLIN_HOLD_SECONDS = 4;

export interface BowGeometry {
  /** Null when the frame has no usable bow geometry (no right wrist, or bow foreshortened). */
  bowFrame: RawBowFrame | null;
  /** Bow stick, frog → tip. */
  bow: { a: NormPoint; b: NormPoint } | null;
  /** Violin strings, scroll → bridge. Survives frames where the violin isn't detected. */
  string: { a: NormPoint; b: NormPoint } | null;
  /**
   * The detector boxes the geometry above was derived from — the bow box as seen
   * this frame, and the violin box actually in use (the held one, so it matches
   * the string line even on frames where the violin wasn't detected).
   */
  boxes: { bow: NormBox | null; violin: NormBox | null };
}

export interface BowGeometryTracker {
  push(input: BowBoxFrameInput): BowGeometry;
  reset(): void;
}

/** Running modal vote that freezes once it has seen `LOCK_SAMPLE` samples. */
function createCornerLock() {
  const votes = new Map<number, number>();
  let sampled = 0;
  let locked: number | null = null;

  return {
    /** Feed this frame's candidate corner; get back the id to actually use. */
    resolve(candidate: number): number {
      if (locked != null) return locked;
      votes.set(candidate, (votes.get(candidate) ?? 0) + 1);
      sampled += 1;
      let best = candidate;
      let bestCount = -1;
      for (const [id, count] of votes) {
        if (count > bestCount) { bestCount = count; best = id; }
      }
      if (sampled >= LOCK_SAMPLE) locked = best;
      return best;
    },
    reset() {
      votes.clear();
      sampled = 0;
      locked = null;
    },
  };
}

export function createBowGeometryTracker(): BowGeometryTracker {
  const frogLock = createCornerLock();
  const scrollLock = createCornerLock();
  let heldViolin: { box: NormBox; timestamp: number } | null = null;
  let orientedByWrist = false;

  const reset = () => {
    frogLock.reset();
    scrollLock.reset();
    heldViolin = null;
    orientedByWrist = false;
  };

  return {
    reset,
    push(input: BowBoxFrameInput): BowGeometry {
      const { bowBox, rightWrist, leftWrist, timestamp } = input;

      if (input.violinBox) heldViolin = { box: input.violinBox, timestamp };
      const violinBox =
        heldViolin && timestamp - heldViolin.timestamp <= VIOLIN_HOLD_SECONDS
          ? heldViolin.box
          : null;

      const boxes = { bow: bowBox, violin: violinBox };

      if (!rightWrist) return { bowFrame: null, bow: null, string: null, boxes };

      // Bow: the frog corner id is voted on, then locked.
      const frogId = frogLock.resolve(nearestCornerId(bowBox, rightWrist));
      const frog = cornerAt(bowBox, frogId);
      const tip = cornerAt(bowBox, oppositeId(frogId));
      if (Math.sqrt(dist2(frog, tip)) < MIN_BOW_DIAGONAL) {
        return { bowFrame: null, bow: null, string: null, boxes };
      }

      let stringDiagonal: [NormPoint, NormPoint] | null = null;
      if (violinBox) {
        // Candidate scroll corner for THIS frame: take the diagonal that crosses
        // the bow, oriented so the scroll end (nearest the left wrist) is first.
        // Voting on the id — not trusting it per-frame — is what stops the flip.
        const [e1] = crossDiagonal(frog, tip, violinBox, leftWrist);
        if (leftWrist) orientedByWrist = true;
        const scrollId = scrollLock.resolve(nearestCornerId(violinBox, e1));
        stringDiagonal = [cornerAt(violinBox, scrollId), cornerAt(violinBox, oppositeId(scrollId))];
      }

      const bowFrame = finishBowFrame(
        { ...input, violinBox },
        frog,
        tip,
        stringDiagonal ? { diagonal: stringDiagonal, oriented: orientedByWrist } : null,
      );

      return {
        bowFrame,
        bow: { a: frog, b: tip },
        string: stringDiagonal ? { a: stringDiagonal[0], b: stringDiagonal[1] } : null,
        boxes,
      };
    },
  };
}
