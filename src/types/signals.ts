import type { NoteEvent } from '../lib/noteFusion';

// ─────────────────────────────────────────────────────────────
// TimeSeries
// ─────────────────────────────────────────────────────────────

export interface TimeSeriesPoint<T> {
  t: number;  // seconds
  v: T;
}

export interface TimeSeries<T> {
  readonly points: ReadonlyArray<TimeSeriesPoint<T>>;
  /**
   * Nearest-neighbor lookup. Returns null if no point within maxGapSeconds
   * (default 0.6s — half a frame interval at 10fps with some slack).
   */
  sample(t: number, maxGapSeconds?: number): T | null;
  /** All points in the closed interval [t0, t1]. */
  window(t0: number, t1: number): Array<TimeSeriesPoint<T>>;
}

export function createTimeSeries<T>(points: Array<TimeSeriesPoint<T>>): TimeSeries<T> {
  // Ensure ascending order
  const sorted = [...points].sort((a, b) => a.t - b.t);

  function sample(t: number, maxGapSeconds = 0.6): T | null {
    if (sorted.length === 0) return null;
    // Binary search for first point >= t
    let lo = 0, hi = sorted.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t < t) lo = mid + 1;
      else hi = mid;
    }
    // Compare point at lo and lo-1, take the closer one
    const candidates: Array<TimeSeriesPoint<T>> = [sorted[lo]];
    if (lo > 0) candidates.push(sorted[lo - 1]);
    const best = candidates.reduce((a, b) =>
      Math.abs(a.t - t) <= Math.abs(b.t - t) ? a : b,
    );
    return Math.abs(best.t - t) > maxGapSeconds ? null : best.v;
  }

  function window(t0: number, t1: number): Array<TimeSeriesPoint<T>> {
    // Binary search for first point >= t0
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid].t < t0) lo = mid + 1;
      else hi = mid;
    }
    const result: Array<TimeSeriesPoint<T>> = [];
    for (let i = lo; i < sorted.length && sorted[i].t <= t1; i++) {
      result.push(sorted[i]);
    }
    return result;
  }

  return { points: sorted, sample, window };
}

// ─────────────────────────────────────────────────────────────
// Raw bow frame (from native bridge)
// ─────────────────────────────────────────────────────────────

/**
 * One frame of bow detector output from the Swift analyzeVideoFrames function.
 * Coordinates are normalized 0-1 in the original video frame (landscape,
 * after appliesPreferredTrackTransform).
 *
 * Three keypoints — tip, frog, and the contact point where bow hair meets the
 * string. The contact point is output directly by the ML model; no per-session
 * calibration is needed. Project contact onto the frog→tip line to get the
 * 0-1 bow usage parameter (see bowAnalysis.ts).
 */
export interface RawBowFrame {
  timestamp: number;
  tipX: number;     tipY: number;     tipVisible: boolean;
  frogX: number;    frogY: number;    frogVisible: boolean;
  contactX: number; contactY: number; contactVisible: boolean;
  confidence: number;
  /** Contact position along the violin's scroll→tailpiece string diagonal
   *  (0 = scroll end / fingerboard, 1 = tailpiece end / bridge). Only present
   *  when the left wrist oriented the diagonal. Placement-scoring proxy until
   *  the bridge detector (Phase 18) exists. */
  stringPosS?: number;
}

// ─────────────────────────────────────────────────────────────
// SessionSignals
// ─────────────────────────────────────────────────────────────

/**
 * All signals for a session stored at their native temporal resolution.
 * Statistical tests query this store directly — nothing is forced into
 * per-note granularity by construction.
 *
 * See bow_analysis.md for the full design rationale.
 */
export interface SessionSignals {
  durationSeconds: number;

  // ── Dense audio (~50 Hz, 20ms hop) ─────────────────────────
  /** Hz; null = unvoiced frame */
  pitch: TimeSeries<number | null>;
  /** RMS amplitude 0-1 */
  rms: TimeSeries<number>;
  /** FFT fundamental/total-power ratio 0-1 (tone quality proxy) */
  fundamentalRatio: TimeSeries<number>;

  // ── Sparse pose (10 fps from analyzeVideoFrames) ────────────
  /** Interior angle at the violin-arm wrist (elbow→wrist→indexMCP), degrees */
  leftWristAngle: TimeSeries<number | null>;
  /** Normalized y of the bow-arm elbow */
  rightElbowY: TimeSeries<number | null>;
  /** Normalized y of the bow-arm shoulder (reference for elbow height) */
  rightShoulderY: TimeSeries<number | null>;
  /** |leftShoulder.y − rightShoulder.y| — shoulder unevenness */
  shoulderDiff: TimeSeries<number | null>;

  // ── Sparse bow (10 fps, high-confidence frames only) ────────
  /** 0 = frog end, 1 = tip end. Derived by projecting the detected string
   *  contact point onto the frog→tip bow stick line — no calibration needed. */
  bowContactPoint: TimeSeries<number | null>;
  /** Bow stick angle relative to horizontal, degrees */
  bowAngle: TimeSeries<number | null>;
  /** Tip speed in normalized frame coords per second */
  bowSpeed: TimeSeries<number | null>;
  /** Stroke direction: +1 = contact moving tipward, -1 = frogward, 0 = stationary.
   *  Geometric sign only — not verified up/down-bow labels (see bowAnalysis.ts). */
  bowDirection: TimeSeries<-1 | 0 | 1 | null>;

  // ── Timbre proxies (~20 Hz, 50ms hop) ───────────────────────
  /** Spectral centroid in Hz — high (>2500) = scratchy, low (<800) = breathy */
  spectralCentroid: TimeSeries<number>;
  /** High-frequency energy ratio: energy above 3 kHz / total energy (0–1) */
  brightness: TimeSeries<number>;

  // ── Segmentation index ──────────────────────────────────────
  /** Audio-derived note events. Lean: no bow/pose fields. */
  noteEvents: NoteEvent[];
}
