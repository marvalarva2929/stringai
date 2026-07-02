import { RawBowFrame, TimeSeries, TimeSeriesPoint, createTimeSeries } from '../types/signals';

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
  }

  return {
    bowContactPoint: createTimeSeries(cpPts),
    bowAngle:        createTimeSeries(anglePts),
    bowSpeed:        createTimeSeries(speedPts),
  };
}
