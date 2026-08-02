import { createTimeSeries, type RawBowFrame, type TimeSeries, type TimeSeriesPoint } from '../types/signals';
import { isClipped } from './bowBoxGeometry';
import type { BowCalibration } from '../types/calibration';

// ─────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────

export const MIN_CONFIDENCE = 0.4;

// Single-frame spike rejection on tip.y
const OUTLIER_TIP_THRESHOLD    = 0.15;
const NEIGHBOR_AGREE_THRESHOLD = 0.08;

// A bow axis shorter than this (normalized) is too foreshortened to trust as a
// full-bow reference length.
export const MIN_BOW_LEN = 0.15;

// ─────────────────────────────────────────────────────────────
// Per-frame geometry
// ─────────────────────────────────────────────────────────────

interface Point { x: number; y: number; }
interface Box { x1: number; y1: number; x2: number; y2: number; }

// Box corner ids: 0 = top-left, 1 = top-right, 2 = bottom-left, 3 = bottom-right.
// The opposite corner across a diagonal is always `3 - id`.
function boxFromEnds(a: Point, b: Point): Box {
  return {
    x1: Math.min(a.x, b.x), y1: Math.min(a.y, b.y),
    x2: Math.max(a.x, b.x), y2: Math.max(a.y, b.y),
  };
}
function cornerAt(box: Box, id: number): Point {
  switch (id) {
    case 0: return { x: box.x1, y: box.y1 };
    case 1: return { x: box.x2, y: box.y1 };
    case 2: return { x: box.x1, y: box.y2 };
    default: return { x: box.x2, y: box.y2 };
  }
}
const oppositeId = (id: number) => 3 - id;
function cornerIdOf(box: Box, p: Point): number {
  const left = Math.abs(p.x - box.x1) <= Math.abs(p.x - box.x2);
  const top = Math.abs(p.y - box.y1) <= Math.abs(p.y - box.y2);
  return (top ? 0 : 2) + (left ? 0 : 1);
}

/**
 * Lock the bow's frog corner once, from the modal choice over the first frames.
 *
 * Each RawBowFrame's (frog, tip) are opposite corners of the bow's bbox, with
 * the frog set to the box corner nearest the right wrist. That per-frame choice
 * occasionally jumps to the OTHER diagonal (wrist jitter / box aspect change),
 * flipping the bow axis mid-clip. Locking the modal corner identity from the
 * start keeps the axis on one diagonal for the whole session.
 */
function lockFrogCorner(frames: RawBowFrame[]): number | null {
  const LOCK_SAMPLE = 15;
  const votes = new Map<number, number>();
  let sampled = 0;
  for (const f of frames) {
    const box = boxFromEnds({ x: f.frogX, y: f.frogY }, { x: f.tipX, y: f.tipY });
    if (box.x2 - box.x1 < 1e-6 && box.y2 - box.y1 < 1e-6) continue;
    const id = cornerIdOf(box, { x: f.frogX, y: f.frogY });
    votes.set(id, (votes.get(id) ?? 0) + 1);
    if (++sampled >= LOCK_SAMPLE) break;
  }
  if (sampled === 0) return null;
  let best: number | null = null;
  let bestC = -1;
  for (const [id, c] of votes) if (c > bestC) { bestC = c; best = id; }
  return best;
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
  // Keep frames where at least one bow end is visible, or where the bow/string
  // contact is visible. Calibration clips are often framed at the frog or tip,
  // so both real endpoints may be out of frame even though the visible bow
  // segment is usable as a raw reference.
  const good = frames.filter(
    f => f.confidence >= MIN_CONFIDENCE && (f.tipVisible || f.frogVisible || f.contactVisible),
  );
  if (good.length < 3) return good;

  // Spike rejection on tip.y — single-frame detection glitches. Only meaningful
  // when the tip is visible across the 3-frame window; otherwise keep the frame.
  return good.filter((f, i) => {
    if (i === 0 || i === good.length - 1) return true;
    const prev = good[i - 1];
    const next = good[i + 1];
    if (!f.tipVisible || !prev.tipVisible || !next.tipVisible) return true;
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
  /**
   * True if the whole bow (frog AND tip both on-screen) was seen at least once,
   * so a real full-bow length could calibrate the contact-point normalization.
   * When false, bowContactPoint is only a truncated-box estimate and distance-
   * based bow metrics should be reported as unreliable.
   */
  fullBowEverSeen: boolean;
  /** True when bowContactPoint/stringPos have been rescaled by applyCalibration()
   *  against a BowCalibration; false for the raw, uncalibrated output of
   *  deriveBowTimeSeries(). Evaluators that need an absolute reference
   *  (stringPos, bowDistribution) should gate on this. */
  calibrated: boolean;
}

export type BowDirection = -1 | 0 | 1;

// ─────────────────────────────────────────────────────────────
// Bow usage (contact-point distribution analysis)
// ─────────────────────────────────────────────────────────────

export type BowZone = 'lower' | 'middle' | 'upper';

export interface BowUsageAnalysis {
  n: number;
  /** 5th / 95th percentile of the contact-point parameter u (0=frog, 1=tip) */
  p05: number;
  p95: number;
  /** p95 − p05: outlier-resistant fraction of the bow actually used */
  robustRange: number;
  meanU: number;
  /** Fraction of samples in each third of the bow */
  zoneShares: Record<BowZone, number>;
  lowerHalfShare: number;
  upperHalfShare: number;
  /** Zone the player camped in (a third or a half dominating the session), or
   *  null when travel is balanced. Thirds are checked first (more specific). */
  campedZone: BowZone | 'lower half' | 'upper half' | null;
  /** Share of samples backing campedZone (0 when campedZone is null) */
  campedShare: number;
}

// Dominance thresholds — a third holding ≥70% of samples, or a half holding
// ≥85%, counts as camping in one region of the bow. Calibrate on real clips.
const BOW_THIRD_DOMINANCE = 0.7;
const BOW_HALF_DOMINANCE = 0.85;

export function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx];
}

/**
 * Distribution statistics over the contact-point parameter u.
 *
 * Uses percentiles rather than min/max so a handful of glitched detection
 * frames can't fake full-bow usage, and zone occupancy so "half the bow, all
 * the time" is visible — raw range alone cannot distinguish strokes centered
 * mid-bow from strokes camped at the tip.
 */
export function analyzeBowUsage(uValues: number[]): BowUsageAnalysis | null {
  if (uValues.length === 0) return null;

  const sorted = [...uValues].sort((a, b) => a - b);
  const p05 = percentile(sorted, 0.05);
  const p95 = percentile(sorted, 0.95);
  const n = uValues.length;

  let lower = 0, middle = 0, upper = 0, lowerHalf = 0, sum = 0;
  for (const u of uValues) {
    sum += u;
    if (u < 1 / 3) lower++;
    else if (u < 2 / 3) middle++;
    else upper++;
    if (u < 0.5) lowerHalf++;
  }

  const zoneShares: Record<BowZone, number> = { lower: lower / n, middle: middle / n, upper: upper / n };
  const lowerHalfShare = lowerHalf / n;
  const upperHalfShare = 1 - lowerHalfShare;

  let campedZone: BowUsageAnalysis['campedZone'] = null;
  let campedShare = 0;
  const thirds: Array<[BowZone, number]> = [['lower', zoneShares.lower], ['middle', zoneShares.middle], ['upper', zoneShares.upper]];
  const dominantThird = thirds.reduce((a, b) => (b[1] > a[1] ? b : a));
  if (dominantThird[1] >= BOW_THIRD_DOMINANCE) {
    campedZone = dominantThird[0];
    campedShare = dominantThird[1];
  } else if (lowerHalfShare >= BOW_HALF_DOMINANCE) {
    campedZone = 'lower half';
    campedShare = lowerHalfShare;
  } else if (upperHalfShare >= BOW_HALF_DOMINANCE) {
    campedZone = 'upper half';
    campedShare = upperHalfShare;
  }

  return {
    n,
    p05,
    p95,
    robustRange: Math.max(0, p95 - p05),
    meanU: sum / n,
    zoneShares,
    lowerHalfShare,
    upperHalfShare,
    campedZone,
    campedShare,
  };
}

/** User-facing name for a camped zone. */
export function bowZoneLabel(zone: NonNullable<BowUsageAnalysis['campedZone']>): string {
  switch (zone) {
    case 'lower': return 'lower third of the bow (near the frog)';
    case 'middle': return 'middle third of the bow';
    case 'upper': return 'upper third of the bow (near the tip)';
    case 'lower half': return 'lower half of the bow';
    case 'upper half': return 'upper half of the bow';
  }
}

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
 * Contact point (bow distribution, 0 = frog, 1 = tip) is measured as the
 * projection of the contact onto the bow axis, divided by a RUNNING full-bow
 * length. Two properties make this robust to the bow running off-frame:
 *
 *   • The frog/tip corners are locked once (lockFrogCorner) so the axis can't
 *     flip diagonals mid-clip.
 *   • The full-bow length is refreshed only on frames where BOTH ends are on-
 *     screen, and each frame anchors the projection off whichever end is
 *     visible (frog forward, or tip backward). So a clipped frog OR a clipped
 *     tip both stay correct — the reading is a fraction of the REAL bow, not of
 *     the truncated bounding box.
 *
 * `fullBowEverSeen` reports whether any frame ever calibrated a real full-bow
 * length; when false the contact-point values are truncated-box estimates.
 *
 * Returns raw, uncalibrated values (`calibrated: false`). Pass the result
 * through `applyCalibration()` below to rescale `bowContactPoint`/`stringPos`
 * against a `BowCalibration` — the per-frame geometry here is untouched by
 * calibration on purpose, so it stays exactly as robust to bow-angle and
 * violin-orientation changes as it always was.
 */
export function deriveBowTimeSeries(frames: RawBowFrame[]): BowTimeSeries {
  const filtered = filterFrames(frames);
  const lockedFrogId = lockFrogCorner(filtered);

  const cpPts:    Array<TimeSeriesPoint<number | null>> = [];
  const anglePts: Array<TimeSeriesPoint<number | null>> = [];
  const speedPts: Array<TimeSeriesPoint<number | null>> = [];
  const posPts:   Array<TimeSeriesPoint<number | null>> = [];
  const lenVals:  Array<number | null> = [];

  // Running full-bow geometry, refreshed whenever the whole bow is on-screen.
  let lastKnownAngleDeg:  number | null = null;
  let lastKnownBowLength: number | null = null;
  let fullBowEverSeen = false;

  for (let i = 0; i < filtered.length; i++) {
    const f = filtered[i];
    const contact = { x: f.contactX, y: f.contactY };

    // Re-derive the bow ends on the LOCKED diagonal so the axis never flips.
    const box = boxFromEnds({ x: f.frogX, y: f.frogY }, { x: f.tipX, y: f.tipY });
    const frog = lockedFrogId != null ? cornerAt(box, lockedFrogId) : { x: f.frogX, y: f.frogY };
    const tip  = lockedFrogId != null ? cornerAt(box, oppositeId(lockedFrogId)) : { x: f.tipX, y: f.tipY };

    const frogClipped = isClipped(frog);
    const tipClipped  = isClipped(tip);
    const lenThis = computeBowLength(tip, frog);

    // Refresh the running full-bow length only when the whole bow is visible.
    if (!frogClipped && !tipClipped && lenThis >= MIN_BOW_LEN) {
      lastKnownAngleDeg  = computeBowAngle(tip, frog);
      lastKnownBowLength = lenThis;
      fullBowEverSeen = true;
    }

    // ── Contact point (bow distribution) ──────────────────────────────────
    // Prefer the box path's pre-computed bowPosT (uploaded-video path) so the
    // metric is identical to the inspector; otherwise reconstruct it here from
    // the locked axis + running length (live streaming path).
    let cp: number | null = null;
    if (f.bowPosT !== undefined) {
      cp = f.bowPosT === null ? null : Math.max(0, Math.min(1, f.bowPosT));
    } else if (f.contactVisible && lenThis > 1e-6) {
      const ux = (tip.x - frog.x) / lenThis;
      const uy = (tip.y - frog.y) / lenThis;
      const L = lastKnownBowLength ?? lenThis; // running length, truncated fallback
      if (!frogClipped) {
        cp = ((contact.x - frog.x) * ux + (contact.y - frog.y) * uy) / L;
      } else if (!tipClipped) {
        cp = 1 - ((tip.x - contact.x) * ux + (tip.y - contact.y) * uy) / L;
      } else {
        // Calibration clips often happen at the frog or tip, where the real
        // bow endpoint can be out of frame. Use the visible bow segment as a
        // raw estimate; applyCalibration() remaps this observed range later.
        cp = ((contact.x - frog.x) * ux + (contact.y - frog.y) * uy) / lenThis;
      }
      if (cp !== null) cp = Math.max(0, Math.min(1, cp));
    }

    // ── Angle: locked axis this frame, else last full-bow angle ───────────
    const angle: number | null = (!frogClipped && !tipClipped)
      ? computeBowAngle(tip, frog)
      : lastKnownAngleDeg;

    // ── Speed: tip-only, available when tip is visible ────────────────────
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
    fullBowEverSeen,
    calibrated: false,
  };
}

/**
 * Rescale a raw BowTimeSeries against a BowCalibration — a linear remap of
 * bowContactPoint/stringPos using where the calibration positions landed in
 * deriveBowTimeSeries' own raw output. The single place calibration should be
 * applied; call it after deriveBowTimeSeries() anywhere a calibrated reading
 * is needed.
 */
export function applyCalibration(series: BowTimeSeries, calibration: BowCalibration | null): BowTimeSeries {
  if (!calibration) return series;

  const rescale = (lo: number, hi: number) => (raw: number | null): number | null => {
    if (raw === null) return null;
    if (Math.abs(hi - lo) < 1e-6) return raw;
    return Math.max(0, Math.min(1, (raw - lo) / (hi - lo)));
  };
  const rescaleContact = rescale(calibration.frogFraction, calibration.tipFraction);
  const rescaleString = rescale(calibration.fingerboardFraction, calibration.bridgeFraction);

  return {
    ...series,
    bowContactPoint: createTimeSeries(
      series.bowContactPoint.points.map((p) => ({ t: p.t, v: rescaleContact(p.v) })),
    ),
    stringPos: createTimeSeries(
      series.stringPos.points.map((p) => ({ t: p.t, v: rescaleString(p.v) })),
    ),
    calibrated: true,
  };
}
