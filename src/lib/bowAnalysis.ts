import { createTimeSeries, type RawBowFrame, type TimeSeries, type TimeSeriesPoint } from '../types/signals';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

const MIN_CONFIDENCE = 0.4;

// Single-frame spike rejection on tip.y
const OUTLIER_TIP_THRESHOLD    = 0.15;
const NEIGHBOR_AGREE_THRESHOLD = 0.08;

// ─────────────────────────────────────────────────────────────
// Per-frame geometry
// ─────────────────────────────────────────────────────────────

interface Point { x: number; y: number; }

/**
 * Where on the bow (0=frog, 1=tip) the string is currently crossed.
 *
 * Full formula — requires all three keypoints visible:
 *   t = dot(contact − frog, tip − frog) / |tip − frog|²
 */
function computeContactPoint(tip: Point, frog: Point, contact: Point): number | null {
  const dx = tip.x - frog.x;
  const dy = tip.y - frog.y;
  const len2 = dx * dx + dy * dy;
  if (len2 < 0.0001) return null;
  const t = ((contact.x - frog.x) * dx + (contact.y - frog.y) * dy) / len2;
  return Math.max(0, Math.min(1, t));
}

/**
 * Fallback contact point when the frog is off-camera.
 *
 * Uses the bow angle and length from the most recent visible-frog frame to
 * reconstruct the bow axis, then projects the contact point onto it.
 *
 * Derivation: the full formula t = dot(contact − frog, u) / bowLength where
 * frog = tip − bowLength * u. Substituting and simplifying:
 *
 *   t = 1 + dot(contact − tip, u) / bowLength
 *
 * where u = (cos θ, sin θ) is the frog→tip unit vector.
 *
 * Accuracy: degrades slowly as the bow arm extends (bow length changes) or
 * rotates (angle changes) relative to the last visible-frog frame. Good for
 * gaps up to ~2 seconds of typical bowing.
 *
 * @param angleDeg  Bow angle in degrees (atan2 convention, frog→tip direction)
 * @param bowLength |tip − frog| in normalized frame coords from last good frame
 */
function computeContactPointFallback(
  tip: Point,
  contact: Point,
  angleDeg: number,
  bowLength: number,
): number | null {
  if (bowLength < 0.001) return null;
  const angleRad = angleDeg * (Math.PI / 180);
  const ux = Math.cos(angleRad);
  const uy = Math.sin(angleRad);
  const dot = (contact.x - tip.x) * ux + (contact.y - tip.y) * uy;
  return Math.max(0, Math.min(1, 1 + dot / bowLength));
}

/**
 * Angle of the bow stick relative to horizontal (degrees).
 * Measured as the frog→tip direction. 0° = horizontal right.
 */
function computeBowAngle(tip: Point, frog: Point): number {
  return Math.atan2(tip.y - frog.y, tip.x - frog.x) * (180 / Math.PI);
}

/** |tip − frog| in normalized frame coords. */
function computeBowLength(tip: Point, frog: Point): number {
  const dx = tip.x - frog.x;
  const dy = tip.y - frog.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Tip speed in normalized frame coords / second. */
function computeBowSpeed(curr: RawBowFrame, prev: RawBowFrame): number | null {
  if (!curr.tipVisible || !prev.tipVisible) return null;
  const dt = curr.timestamp - prev.timestamp;
  if (dt < 0.01) return null;
  const dx = curr.tipX - prev.tipX;
  const dy = curr.tipY - prev.tipY;
  return Math.sqrt(dx * dx + dy * dy) / dt;
}

// ─────────────────────────────────────────────────────────────
// Frame filtering
// ─────────────────────────────────────────────────────────────

function filterFrames(frames: RawBowFrame[]): RawBowFrame[] {
  // Keep frames where at least the tip is visible and confidence is acceptable.
  // Frog-invisible frames are intentionally kept — the fallback formula handles them.
  const good = frames.filter(
    f => f.confidence >= MIN_CONFIDENCE && f.tipVisible,
  );
  if (good.length < 3) return good;

  // Spike rejection on tip.y — single-frame detection glitches
  return good.filter((f, i) => {
    if (i === 0 || i === good.length - 1) return true;
    const prev = good[i - 1];
    const next = good[i + 1];
    const diffPrev     = Math.abs(f.tipY - prev.tipY);
    const diffNext     = Math.abs(f.tipY - next.tipY);
    const neighborDiff = Math.abs(prev.tipY - next.tipY);
    return !(
      diffPrev > OUTLIER_TIP_THRESHOLD &&
      diffNext > OUTLIER_TIP_THRESHOLD &&
      neighborDiff < NEIGHBOR_AGREE_THRESHOLD
    );
  });
}

// ─────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────

export interface BowTimeSeries {
  bowContactPoint: TimeSeries<number | null>;
  bowAngle:        TimeSeries<number | null>;
  bowSpeed:        TimeSeries<number | null>;
  /**
   * Stroke direction: +1 = contact point moving tipward, -1 = frogward,
   * 0 = stationary, null = not measurable this frame.
   *
   * Sign semantics are geometric (contact travel along the frog→tip axis),
   * NOT verified up-bow/down-bow labels — don't render bowing terms to users
   * until checked against real footage.
   */
  bowDirection:    TimeSeries<BowDirection | null>;
  /**
   * Contact position along the violin string diagonal (0 = scroll end,
   * 1 = tailpiece end). Placement proxy from RawBowFrame.stringPosS; null
   * when the diagonal orientation was unknown or no contact was found.
   */
  stringPos:       TimeSeries<number | null>;
}

export type BowDirection = -1 | 0 | 1;

// ─────────────────────────────────────────────────────────────
// Bow direction
// ─────────────────────────────────────────────────────────────

// u̇ (bow-lengths/sec) below this = stationary. ~5% of the bow per second.
const DIRECTION_STATIONARY_THRESHOLD = 0.05;
// EMA alpha for contact-point smoothing (~3-frame effective window at 10 fps).
const DIRECTION_SMOOTH_ALPHA = 0.5;
// A candidate direction must persist this many consecutive frames before the
// committed direction flips — single-frame jitter would shred L5 slur groups.
const DIRECTION_HYSTERESIS_FRAMES = 2;
// Gaps longer than this break the derivative (and reset smoothing state).
const DIRECTION_MAX_GAP_S = 0.5;

/**
 * Per-frame raw direction from the primary + fallback signals:
 *   1. Derivative of the EMA-smoothed contact-point parameter u (0=frog, 1=tip).
 *      Camera-framing invariant, and immune to the tip swinging fast during
 *      angle changes without any real stroke.
 *   2. Fallback when contact is null: tip velocity projected onto the frog→tip
 *      axis, normalized by bow length so the same threshold applies.
 */
function deriveDirectionPoints(
  filtered: RawBowFrame[],
  contactPoints: Array<TimeSeriesPoint<number | null>>,
  anglePoints: Array<TimeSeriesPoint<number | null>>,
  bowLengths: Array<number | null>,
): Array<TimeSeriesPoint<BowDirection | null>> {
  const out: Array<TimeSeriesPoint<BowDirection | null>> = [];

  let smoothedU: number | null = null;
  let prevSmoothedU: number | null = null;
  let prevT: number | null = null;

  let committed: BowDirection | null = null;
  let pending: BowDirection | null = null;
  let pendingRun = 0;

  for (let i = 0; i < filtered.length; i++) {
    const f = filtered[i];
    const t = f.timestamp;
    const gapBroken = prevT !== null && t - prevT > DIRECTION_MAX_GAP_S;
    if (gapBroken) {
      smoothedU = null;
      committed = null;
      pending = null;
      pendingRun = 0;
    }

    // ── Raw per-frame u̇ ──
    let uDot: number | null = null;

    const cp = contactPoints[i].v;
    if (cp !== null) {
      prevSmoothedU = smoothedU;
      smoothedU = smoothedU === null
        ? cp
        : DIRECTION_SMOOTH_ALPHA * cp + (1 - DIRECTION_SMOOTH_ALPHA) * smoothedU;
      if (prevSmoothedU !== null && prevT !== null && t - prevT >= 0.01) {
        uDot = (smoothedU - prevSmoothedU) / (t - prevT);
      }
    } else if (i > 0 && prevT !== null && t - prevT >= 0.01 && !gapBroken) {
      // Fallback: signed tip velocity along the bow axis, in bow-lengths/sec
      const prev = filtered[i - 1];
      const angle = anglePoints[i].v;
      const len = bowLengths[i];
      if (f.tipVisible && prev.tipVisible && angle !== null && len !== null && len > 0.001) {
        const rad = angle * (Math.PI / 180);
        const vAlong = ((f.tipX - prev.tipX) * Math.cos(rad) + (f.tipY - prev.tipY) * Math.sin(rad)) / (t - prevT);
        uDot = vAlong / len;
      }
      // A null contact frame breaks the smoothed-u chain
      smoothedU = null;
    } else {
      smoothedU = null;
    }

    prevT = t;

    if (uDot === null) {
      out.push({ t, v: committed });
      continue;
    }

    const raw: BowDirection =
      Math.abs(uDot) < DIRECTION_STATIONARY_THRESHOLD ? 0 : uDot > 0 ? 1 : -1;

    // ── Hysteresis ──
    if (committed === null) {
      committed = raw;
    } else if (raw === committed) {
      pending = null;
      pendingRun = 0;
    } else {
      if (raw === pending) {
        pendingRun++;
      } else {
        pending = raw;
        pendingRun = 1;
      }
      if (pendingRun >= DIRECTION_HYSTERESIS_FRAMES) {
        committed = raw;
        pending = null;
        pendingRun = 0;
      }
    }

    out.push({ t, v: committed });
  }

  return out;
}

/**
 * Convert RawBowFrame[] into semantic bow time series.
 *
 * Contact point strategy (in priority order per frame):
 *   1. All three keypoints visible → full projection formula (most accurate)
 *   2. Frog off-camera, tip + contact visible → fallback formula using last
 *      known angle + bow length (see computeContactPointFallback)
 *   3. Contact also not visible → null for this frame
 *
 * Angle and bow length are updated only from frames where the frog is visible,
 * so the fallback always uses real geometry, not estimated geometry.
 */
export function deriveBowTimeSeries(frames: RawBowFrame[]): BowTimeSeries {
  const filtered = filterFrames(frames);

  const cpPts:    Array<TimeSeriesPoint<number | null>> = [];
  const anglePts: Array<TimeSeriesPoint<number | null>> = [];
  const speedPts: Array<TimeSeriesPoint<number | null>> = [];
  const posPts:   Array<TimeSeriesPoint<number | null>> = [];
  const lenVals:  Array<number | null> = [];

  // Carry-forward state for the frog-invisible fallback
  let lastKnownAngleDeg:    number | null = null;
  let lastKnownBowLength:   number | null = null;

  for (let i = 0; i < filtered.length; i++) {
    const f       = filtered[i];
    const tip     = { x: f.tipX,     y: f.tipY     };
    const frog    = { x: f.frogX,    y: f.frogY    };
    const contact = { x: f.contactX, y: f.contactY };

    const stickVisible   = f.tipVisible && f.frogVisible;
    const contactVisible = f.contactVisible;

    // ── Update carry-forward state whenever frog is visible ──────────────
    if (stickVisible) {
      lastKnownAngleDeg  = computeBowAngle(tip, frog);
      lastKnownBowLength = computeBowLength(tip, frog);
    }

    // ── Contact point ─────────────────────────────────────────────────────
    let cp: number | null = null;
    if (stickVisible && contactVisible) {
      // All three keypoints: full formula
      cp = computeContactPoint(tip, frog, contact);
    } else if (!f.frogVisible && f.tipVisible && contactVisible &&
               lastKnownAngleDeg !== null && lastKnownBowLength !== null) {
      // Frog off-camera: fallback using last known bow geometry
      cp = computeContactPointFallback(tip, contact, lastKnownAngleDeg, lastKnownBowLength);
    }

    // ── Angle: always use lastKnownAngleDeg (just updated above if frog visible)
    const angle: number | null = lastKnownAngleDeg;

    // ── Speed: tip-only, always available when tip is visible ─────────────
    const speed = i > 0 ? computeBowSpeed(f, filtered[i - 1]) : null;

    cpPts.push(   { t: f.timestamp, v: cp    });
    anglePts.push({ t: f.timestamp, v: angle });
    speedPts.push({ t: f.timestamp, v: speed });
    posPts.push(  { t: f.timestamp, v: f.stringPosS ?? null });
    lenVals.push(lastKnownBowLength);
  }

  const dirPts = deriveDirectionPoints(filtered, cpPts, anglePts, lenVals);

  return {
    bowContactPoint: createTimeSeries(cpPts),
    bowAngle:        createTimeSeries(anglePts),
    bowSpeed:        createTimeSeries(speedPts),
    bowDirection:    createTimeSeries(dirPts),
    stringPos:       createTimeSeries(posPts),
  };
}
