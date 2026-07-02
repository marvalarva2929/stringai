/**
 * Pose-based metric scoring for violin analysis.
 *
 * All functions are pure — no MediaPipe dependency here. They accept normalized
 * landmark coordinates (x/y in 0-1, origin top-left) as produced by MediaPipe
 * Pose and Hands models at 2 fps.
 *
 * Coordinates assume a FRONT-FACING (selfie) camera, which mirrors the image:
 *   - Player's right arm (bow arm) → appears on LEFT side of frame (lower x)
 *   - Player's left arm (violin arm) → appears on RIGHT side of frame (higher x)
 *   - rightShoulder.x < leftShoulder.x always
 */

import { MetricScore, MetricKey, MeasurementQuality, TechniqueEvent, FlaggedTimestamp, severityFromScore } from '../types/analysis';
import { InstrumentId } from '../types/instrument';
import { RawBowFrame } from '../types/signals';
import { deriveBowTimeSeries, BowTimeSeries } from './bowAnalysis';

// ─────────────────────────────────────────────────────────────
// Landmark type definitions (MediaPipe format)
// ─────────────────────────────────────────────────────────────

export interface Landmark {
  x: number;       // 0-1, left to right in image
  y: number;       // 0-1, top to bottom in image
  z: number;       // depth (relative, less reliable)
  visibility?: number; // 0-1, confidence
  wx?: number;     // world x (metres relative to wrist, from MediaPipe world landmarks)
  wy?: number;
  wz?: number;
}

// MediaPipe Pose — 33 landmarks
export const POSE = {
  NOSE: 0,
  LEFT_SHOULDER: 11,
  RIGHT_SHOULDER: 12,
  LEFT_ELBOW: 13,
  RIGHT_ELBOW: 14,
  LEFT_WRIST: 15,
  RIGHT_WRIST: 16,
  LEFT_PINKY_TIP: 17,
  LEFT_INDEX_TIP: 19,
} as const;

// MediaPipe Hands — 21 landmarks per hand
export const HAND = {
  WRIST: 0,
  INDEX_MCP: 5,
  MIDDLE_MCP: 9,
  RING_MCP: 13,
} as const;

export interface FrameKeypoints {
  timestamp: number;                      // seconds into the recording
  poseLandmarks: Landmark[] | null;       // 33 pose landmarks, null if not detected
  leftHandLandmarks: Landmark[] | null;   // 21 hand landmarks, null if not detected
  rightHandLandmarks: Landmark[] | null;  // 21 hand landmarks, null if not detected
}

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

export const CONFIDENCE_THRESHOLD = 0.6;
const MIN_CONSECUTIVE_FRAMES = 5;

function clamp(v: number, lo = 0, hi = 100): number {
  return Math.max(lo, Math.min(hi, v));
}

function deg(radians: number): number {
  return radians * (180 / Math.PI);
}

function visible(lm: Landmark, threshold = CONFIDENCE_THRESHOLD): boolean {
  return lm.visibility === undefined || lm.visibility >= threshold;
}

// Interior angle at joint b (degrees). Returns 180 when points are coincident
// (e.g. arm pointing straight at camera) so foreshortened frames read as "straight".
export function jointAngle(a: Landmark, b: Landmark, c: Landmark): number {
  const abx = a.x - b.x, aby = a.y - b.y;
  const cbx = c.x - b.x, cby = c.y - b.y;
  const mag = Math.sqrt((abx ** 2 + aby ** 2) * (cbx ** 2 + cby ** 2));
  if (mag < 0.0001) return 180;
  return deg(Math.acos(Math.max(-1, Math.min(1, (abx * cbx + aby * cby) / mag))));
}


/**
 * Z-component of the palm's unit normal vector computed from MediaPipe world landmarks.
 * Returns null when world coordinates are unavailable (uploaded video, Android, or when
 * the model file is missing). When present:
 *   > 0  → palm faces camera (can see palm creases)
 *   < 0  → back of hand faces camera (dorsal view, typical violin position)
 *   ≈ 0  → palm is edge-on (unreliable for 2D wrist angle)
 * Magnitude encodes how face-on the palm is; |z| < 0.25 means the palm is too
 * edge-on to reliably measure wrist collapse from this view angle.
 */
export function palmNormalZ(hand: Landmark[]): number | null {
  const w = hand[HAND.WRIST];
  const ix = hand[HAND.INDEX_MCP];
  const rg = hand[HAND.RING_MCP];
  if (w?.wx == null || ix?.wx == null || rg?.wx == null) return null;
  const ax = ix.wx - w.wx, ay = ix.wy! - w.wy!, az = ix.wz! - w.wz!;
  const bx = rg.wx - w.wx, by = rg.wy! - w.wy!, bz = rg.wz! - w.wz!;
  const cx = ay * bz - az * by;
  const cy = az * bx - ax * bz;
  const cz = ax * by - ay * bx;
  const mag = Math.sqrt(cx * cx + cy * cy + cz * cz);
  return mag < 0.0001 ? null : cz / mag;
}

/** Keep only indexes that belong to runs of at least minLength consecutive frames. */
export function filterConsecutiveRuns(indexes: number[], minLength = MIN_CONSECUTIVE_FRAMES): number[] {
  if (indexes.length === 0) return [];
  const sorted = [...indexes].sort((a, b) => a - b);
  const result: number[] = [];
  let runStart = 0;

  for (let i = 1; i <= sorted.length; i++) {
    const endRun = i === sorted.length || sorted[i] !== sorted[i - 1] + 1;
    if (endRun) {
      const runLen = i - runStart;
      if (runLen >= minLength) {
        for (let j = runStart; j < i; j++) result.push(sorted[j]);
      }
      runStart = i;
    }
  }
  return result;
}

function unavailableMetric(key: MetricKey, reason?: string): MetricScore {
  return {
    key,
    score: 0,
    flaggedTimestamps: [],
    severity: 'good',
    events: [],
    occurrenceRate: 0,
    observationSummary: reason ?? 'Bow tracking data not available for this session.',
    measurementQuality: 'unavailable',
  };
}

// Collapse a run of contiguous flagged frames into FlaggedTimestamp spans.
function framesToTimestamps(
  flaggedFrames: number[],
  frameTimestamps: number[],
  note: string,
  minGapSeconds = 0.5,
): FlaggedTimestamp[] {
  if (flaggedFrames.length === 0) return [];
  const result: FlaggedTimestamp[] = [];
  let start = frameTimestamps[flaggedFrames[0]];
  let prev = flaggedFrames[0];

  for (let i = 1; i < flaggedFrames.length; i++) {
    const curr = flaggedFrames[i];
    const gap = frameTimestamps[curr] - frameTimestamps[prev];
    if (gap > minGapSeconds) {
      result.push({ startSeconds: start, endSeconds: frameTimestamps[prev] + 0.5, note });
      start = frameTimestamps[curr];
    }
    prev = curr;
  }
  result.push({ startSeconds: start, endSeconds: frameTimestamps[prev] + 0.5, note });
  return result.slice(0, 6);
}

// Count distinct "entry" events: transitions from good→bad state in flaggedIndexes.
function countEntries(flaggedIndexes: number[]): number {
  if (flaggedIndexes.length === 0) return 0;
  let count = 1;
  for (let i = 1; i < flaggedIndexes.length; i++) {
    if (flaggedIndexes[i] !== flaggedIndexes[i - 1] + 1) count++;
  }
  return count;
}

// Convert flagged timestamp spans to TechniqueEvents.
function timestampsToEvents(
  flaggedTimestamps: FlaggedTimestamp[],
  type: string,
): TechniqueEvent[] {
  return flaggedTimestamps.map((ts) => ({
    type,
    startSeconds: ts.startSeconds,
    endSeconds: ts.endSeconds,
  }));
}

// ─────────────────────────────────────────────────────────────
// Thresholds (calibrate via debug screen once real data exists)
// ─────────────────────────────────────────────────────────────

const THRESHOLDS = {
  leftHandWrist: {
    // Interior angle at the wrist (elbow→wrist→indexMCP). 180° = straight.
    // Below this threshold the wrist is collapsed inward.
    minStraightAngle: 160,
  },
  posture: {
    // |leftShoulder.y − rightShoulder.y| in normalized frame coords.
    // Violin players have natural asymmetry so this is intentionally lenient.
    shoulderDiff: 0.05,
  },
  bow: {
    // Deviation from the session-median bow angle that triggers a flag.
    // Using session median as baseline makes this camera-angle agnostic.
    angleDeviationDeg: 15,
    // Minimum fraction of bow length (0-1) the player must use.
    // Below this the distribution is considered too narrow.
    minDistributionRange: 0.35,
    // Minimum bow frames required before a metric is considered reliable.
    minFrames: 5,
  },
};

// ─────────────────────────────────────────────────────────────
// Per-metric scoring
// ─────────────────────────────────────────────────────────────

// Bow placement (sul ponticello / normal / sul tasto) requires knowing bridge
// position in the frame, which needs a bridge detector. Deferred.
function scoreBowPlacement(_bow: BowTimeSeries): MetricScore {
  return unavailableMetric('bowPlacement', 'Bow contact zone (bridge vs fingerboard) requires bridge position detection — coming in a future update.');
}

function scoreBowAngle(bow: BowTimeSeries): MetricScore {
  const pts = bow.bowAngle.points.filter(p => p.v !== null) as Array<{ t: number; v: number }>;
  if (pts.length < THRESHOLDS.bow.minFrames) {
    return unavailableMetric('bowAngle', 'Not enough bow frames detected in this session.');
  }

  // Session median as baseline — makes this robust to camera tilt/orientation.
  const sorted = [...pts].map(p => p.v).sort((a, b) => a - b);
  const baseline = sorted[Math.floor(sorted.length / 2)];
  const timestamps = pts.map(p => p.t);

  const flaggedIndexes: number[] = [];
  let goodFrames = 0;
  for (let i = 0; i < pts.length; i++) {
    if (Math.abs(pts[i].v - baseline) <= THRESHOLDS.bow.angleDeviationDeg) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = clamp(Math.round((goodFrames / pts.length) * 100));
  const occurrenceRate = confirmedFlags.length / pts.length;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Bow angle deviation — keep the stick more consistent');
  const events = timestampsToEvents(flaggedTimestamps, 'bow_angle_deviation');

  const entryCount = countEntries(confirmedFlags);
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary = entryCount === 0
    ? 'Bow stick angle was consistent throughout.'
    : ratePct >= 50
    ? `Bow stick tilted beyond normal range ${ratePct}% of the session.`
    : `Bow angle deviation detected ${entryCount} ${entryCount === 1 ? 'time' : 'times'}.`;

  return {
    key: 'bowAngle',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'high',
  };
}

// Bow arm level requires correlating elbow height to the current string (from pitch).
// Partial — needs pitch-string mapping from SessionSignals. Deferred to next sprint.
function scoreBowArmLevel(_bow: BowTimeSeries, _instrument: InstrumentId): MetricScore {
  return unavailableMetric('bowArmLevel', 'Bow arm level assessment requires pitch-to-string mapping — coming in next sprint.');
}

function scoreBowDistribution(bow: BowTimeSeries): MetricScore {
  const pts = bow.bowContactPoint.points.filter(p => p.v !== null) as Array<{ t: number; v: number }>;
  if (pts.length < THRESHOLDS.bow.minFrames) {
    return unavailableMetric('bowDistribution', 'Not enough bow frames detected in this session.');
  }

  const values = pts.map(p => p.v);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min;

  let score: number;
  if (range >= 0.7)  score = 92;
  else if (range >= 0.5) score = 78;
  else if (range >= THRESHOLDS.bow.minDistributionRange) score = 62;
  else score = 35;

  const pctUsed = Math.round(range * 100);
  const observationSummary = range >= 0.7
    ? `Using ${pctUsed}% of the bow — excellent range.`
    : range >= 0.5
    ? `Using ${pctUsed}% of the bow — good range.`
    : range >= THRESHOLDS.bow.minDistributionRange
    ? `Using only ${pctUsed}% of the bow — try to extend to the tip and frog more.`
    : `Using only ${pctUsed}% of the bow — very restricted range.`;

  return {
    key: 'bowDistribution',
    score,
    flaggedTimestamps: [],
    severity: severityFromScore(score),
    events: [],
    occurrenceRate: range < THRESHOLDS.bow.minDistributionRange ? 1.0 : 0,
    observationSummary,
    measurementQuality: 'high',
  };
}

function scoreLeftHandWrist(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  const timeSeries: Array<{ t: number; v: number }> = [];
  const debugSeries: Array<{ t: number; cos: number | null; magF: number | null; magH: number | null; mode: '3D' | '2D' }> = [];
  let goodFrames = 0;
  let totalFrames = 0;
  let noDataFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const pose = frames[i].poseLandmarks;
    if (!pose) { noDataFrames++; continue; }

    const elbow    = pose[POSE.LEFT_ELBOW];
    const wrist    = pose[POSE.LEFT_WRIST];
    const indexTip = pose[POSE.LEFT_INDEX_TIP];
    if (!elbow || !wrist || !indexTip) { noDataFrames++; continue; }
    if (!visible(elbow) || !visible(wrist) || !visible(indexTip)) { noDataFrames++; continue; }

    // All three landmarks come from the same MediaPipe Pose world coordinate frame
    // (hip-centred, metres). The 3D angle is camera-angle-independent and needs no
    // palm-orientation gate. Fall back to the 2D projected angle when world coords
    // are unavailable (e.g. useMpPose prop is off).
    let angle: number;
    if (elbow.wx != null && wrist.wx != null && indexTip.wx != null) {
      const fax = elbow.wx - wrist.wx, fay = elbow.wy! - wrist.wy!, faz = elbow.wz! - wrist.wz!;
      const hx = indexTip.wx - wrist.wx, hy = indexTip.wy! - wrist.wy!, hz = indexTip.wz! - wrist.wz!;
      const magF = Math.sqrt(fax * fax + fay * fay + faz * faz);
      const magH = Math.sqrt(hx * hx + hy * hy + hz * hz);
      if (magF < 0.0001 || magH < 0.0001) { noDataFrames++; continue; }
      const cosA = Math.max(-1, Math.min(1, (fax * hx + fay * hy + faz * hz) / (magF * magH)));
      angle = deg(Math.acos(cosA));
      debugSeries.push({ t: timestamps[i], cos: Math.round(cosA * 100) / 100, magF: Math.round(magF * 100), magH: Math.round(magH * 100), mode: '3D' });
    } else {
      angle = jointAngle(elbow, wrist, indexTip);
      debugSeries.push({ t: timestamps[i], cos: null, magF: null, magH: null, mode: '2D' });
    }

    totalFrames++;
    timeSeries.push({ t: timestamps[i], v: angle });
    if (angle >= THRESHOLDS.leftHandWrist.minStraightAngle) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  // 3-frame sliding median to smooth the graph display.
  // Violation detection uses frame indices above, so it is unaffected.
  const smoothedTimeSeries = timeSeries.map((pt, i) => {
    const win = timeSeries.slice(Math.max(0, i - 1), i + 2).map(p => p.v).sort((a, b) => a - b);
    return { t: pt.t, v: win[Math.floor(win.length / 2)] };
  });

  const allFrames = totalFrames + noDataFrames;
  const quality: MeasurementQuality =
    allFrames < 5 || totalFrames / Math.max(allFrames, 1) < 0.30 ? 'low' : 'high';

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = totalFrames > 0 ? clamp(Math.round((goodFrames / totalFrames) * 100)) : 65;
  const occurrenceRate = totalFrames > 0 ? confirmedFlags.length / totalFrames : 0;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Left wrist collapsing inward');
  const events = timestampsToEvents(flaggedTimestamps, 'wrist_collapse');
  const entryCount = countEntries(confirmedFlags);
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    totalFrames === 0
      ? 'Left hand was not visible — keep your left wrist in frame for this metric.'
      : entryCount === 0
      ? 'Left wrist stayed well-aligned throughout.'
      : ratePct >= 50
      ? `Left wrist was collapsed ${ratePct}% of the session.`
      : `Left wrist collapsed ${entryCount} ${entryCount === 1 ? 'time' : 'times'}.`;

  // Log every frame so we can inspect from Metro logs.
  // grep for WRIST_DEBUG in the Metro terminal output.
  if (debugSeries.length > 0) {
    console.log('WRIST_DEBUG', JSON.stringify(debugSeries));
  }

  return {
    key: 'leftHandWrist',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: quality,
    timeSeries: smoothedTimeSeries.length >= 2 ? smoothedTimeSeries : undefined,
    debugSeries: debugSeries.length >= 2 ? debugSeries : undefined,
  };
}

function scorePosture(frames: FrameKeypoints[]): MetricScore {
  const flaggedIndexes: number[] = [];
  const timestamps = frames.map((f) => f.timestamp);
  let goodFrames = 0;
  let totalFrames = 0;

  for (let i = 0; i < frames.length; i++) {
    const pose = frames[i].poseLandmarks;
    if (!pose) continue;

    const lShoulder = pose[POSE.LEFT_SHOULDER];
    const rShoulder = pose[POSE.RIGHT_SHOULDER];
    // Violin players must tilt their head to hold the instrument — head position is
    // intentionally excluded. Shoulder level is the only reliable posture signal
    // measurable from a front-facing camera.
    if (!visible(lShoulder) || !visible(rShoulder)) continue;

    const shoulderDiff = Math.abs(lShoulder.y - rShoulder.y);

    totalFrames++;
    if (shoulderDiff <= THRESHOLDS.posture.shoulderDiff) {
      goodFrames++;
    } else {
      flaggedIndexes.push(i);
    }
  }

  const confirmedFlags = filterConsecutiveRuns(flaggedIndexes);
  const score = totalFrames > 0
    ? clamp(Math.round((goodFrames / totalFrames) * 100))
    : 75;
  const occurrenceRate = totalFrames > 0 ? confirmedFlags.length / totalFrames : 0;
  const flaggedTimestamps = framesToTimestamps(confirmedFlags, timestamps, 'Shoulders uneven — try to keep them level');
  const events = timestampsToEvents(flaggedTimestamps, 'shoulder_uneven');
  const ratePct = Math.round(occurrenceRate * 100);
  const observationSummary =
    totalFrames === 0
      ? 'Step back so your shoulders are fully visible for posture assessment.'
      : occurrenceRate === 0
      ? 'Shoulders stayed level throughout the session.'
      : ratePct >= 40
      ? `Shoulder unevenness present ${ratePct}% of the session.`
      : `Uneven shoulders detected ${flaggedTimestamps.length} ${flaggedTimestamps.length === 1 ? 'time' : 'times'}.`;
  return {
    key: 'posture',
    score,
    flaggedTimestamps,
    severity: severityFromScore(score),
    events,
    occurrenceRate,
    observationSummary,
    measurementQuality: 'high',
  };
}

// ─────────────────────────────────────────────────────────────
// Public entry point
// ─────────────────────────────────────────────────────────────

/**
 * Score all video-based metrics from pose frames and bow detector output.
 *
 * @param frames    Normalized FrameKeypoints[] (after preparePoseFramesForScoring).
 * @param bowFrames RawBowFrame[] from the native bow detector. Pass [] when
 *                  bow data is unavailable — bow metrics gracefully return
 *                  measurementQuality: 'unavailable'.
 * @param instrument Instrument config key.
 */
export function scorePoseMetrics(
  frames: FrameKeypoints[],
  bowFrames: RawBowFrame[],
  instrument: InstrumentId,
  _duration: number,
): MetricScore[] {
  if (frames.length === 0) return [];
  const bow = deriveBowTimeSeries(bowFrames);
  return [
    scoreBowPlacement(bow),
    scoreBowAngle(bow),
    scoreBowArmLevel(bow, instrument),
    scoreBowDistribution(bow),
    scoreLeftHandWrist(frames),
    scorePosture(frames),
  ];
}
